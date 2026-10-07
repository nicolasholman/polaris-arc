/**
 * lib/verify.js: verifying a contract whose sources moved on after it was
 * deployed. PolarisCheckout on Monad testnet was built at the deploy commit;
 * reauthorize has changed since, so today's sources no longer reproduce it
 * and hardhat-verify would refuse it. The deploy commit's sources, read from
 * git, must reproduce it exactly (the executable code; Etherscan ignores the
 * metadata), and today's must not.
 */
const { expect } = require("chai");
const { execFileSync } = require("node:child_process");
const hre = require("hardhat");
const { ethers } = hre;

const {
  argsFromCreation,
  closureInput,
  compileFor,
  headSource,
  repoRoot,
  sameExecutable,
  sourcesFor,
  sourcesUnchangedSince,
  standardInputAt,
  verificationInput,
  verificationTargets,
  withoutMetadata,
  zeroImmutables,
} = require("../../lib/verify");
const { ETHERSCAN_V2_API, codeUrl, monadscan, verificationRecord } = require("../../lib/monadscan");

/** The commit deploy:monad built every contract on Monad testnet from (28 Sep 2026). */
const DEPLOY_COMMIT = "020484b2aea74bde3f2cbc918d534dbda1348723";
const CHECKOUT = "contracts/PolarisCheckout.sol:PolarisCheckout";

function haveCommit(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot() });
    return true;
  } catch {
    return false;
  }
}

describe("verifying a contract built from an earlier commit (lib/verify.js)", function () {
  this.timeout(300_000);

  it("compares code as Etherscan does: immutables zeroed, metadata left out", () => {
    // 6 bytes of code, then 4 bytes of CBOR metadata and its length (0x0004).
    const code = "0x60806040526011aabbccdd0004";
    expect(withoutMetadata(code)).to.equal("60806040526011");
    expect(zeroImmutables("0x6080604052ff", { 1: [{ start: 5, length: 1 }] })).to.equal("608060405200");
    const refs = { 7: [{ start: 1, length: 2 }] };
    expect(sameExecutable("0x61abcd00" + "11220002", "0x61000000" + "33440002", refs)).to.equal(true);
    expect(sameExecutable("0x62abcd00" + "11220002", "0x61000000" + "33440002", refs)).to.equal(false);
    expect(sameExecutable("0x", "0x6080", {})).to.equal(false);
  });

  it("rebuilds PolarisCheckout as deployed on Monad testnet from git, and tells it from today's", async function () {
    if (!haveCommit(DEPLOY_COMMIT)) this.skip();
    expect(sourcesUnchangedSince(DEPLOY_COMMIT)).to.equal(false, "reauthorize has changed since the deploy");
    const { input, solcVersion, solcLongVersion } = await standardInputAt(hre, CHECKOUT, DEPLOY_COMMIT);
    expect(solcLongVersion).to.match(/^0\.8\.\d+\+commit\./);
    expect(input.sources["contracts/PolarisCheckout.sol"].content).to.not.include("reauthorizedThrough");
    const old = await compileFor(hre, input, solcVersion, CHECKOUT);

    // The deploy commit's PolarisCheckout, deployed here as deploy:monad did it.
    const [owner, treasury] = await ethers.getSigners();
    const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, ausd, scores, treasury.address, 3600, 60);
    const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, ausd, treasury.address, 60);
    const args = [owner.address, await engine.getAddress(), await payments.getAddress(), await scores.getAddress()];
    const deployed = await new ethers.ContractFactory(old.abi, old.bytecode, owner).deploy(...args);
    const today = await (await ethers.getContractFactory("PolarisCheckout")).deploy(...args);

    // Its code is the deploy commit's build, not today's.
    const onChain = await ethers.provider.getCode(await deployed.getAddress());
    expect(sameExecutable(onChain, old.deployedBytecode, old.immutableReferences)).to.equal(true);
    const artifact = await hre.artifacts.readArtifact(CHECKOUT);
    expect(sameExecutable(onChain, artifact.deployedBytecode, old.immutableReferences)).to.equal(false);

    // So verify-monad submits the deploy commit's sources for it, and today's for a current deployment.
    const found = await sourcesFor(hre, { fqn: CHECKOUT, address: await deployed.getAddress(), commit: DEPLOY_COMMIT });
    expect(found.from).to.equal(DEPLOY_COMMIT);
    expect(found.input.sources["contracts/PolarisCheckout.sol"].content).to.equal(input.sources["contracts/PolarisCheckout.sol"].content);
    expect((await sourcesFor(hre, { fqn: CHECKOUT, address: await today.getAddress(), commit: DEPLOY_COMMIT })).from).to.equal("today");
    let err;
    try {
      await sourcesFor(hre, { fqn: CHECKOUT, address: await deployed.getAddress(), commit: null });
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.match(/names no sourceCommit/);
  });

  it("prefers the deploy commit's text when today's differs only in comments (CollectionsReceiver's NatSpec)", async function () {
    if (!haveCommit(DEPLOY_COMMIT)) this.skip();
    const fqn = "contracts/cre/CollectionsReceiver.sol:CollectionsReceiver";
    const { input, solcVersion } = await standardInputAt(hre, fqn, DEPLOY_COMMIT);
    const old = await compileFor(hre, input, solcVersion, fqn);
    const [owner] = await ethers.getSigners();
    const args = [1, 2, 3, 4].map(() => ethers.Wallet.createRandom().address);
    const deployed = await new ethers.ContractFactory(old.abi, old.bytecode, owner).deploy(...args);
    const address = await deployed.getAddress();

    // Today's sources run the same code, but only the deploy commit's give the same bytes, metadata included.
    const artifact = await hre.artifacts.readArtifact(fqn);
    const onChain = await ethers.provider.getCode(address);
    expect(sameExecutable(onChain, artifact.deployedBytecode, old.immutableReferences)).to.equal(true);
    expect(onChain.toLowerCase()).to.not.equal(artifact.deployedBytecode.toLowerCase());

    const found = await verificationInput(hre, { fqn, address, commit: DEPLOY_COMMIT });
    expect(found.from).to.equal(DEPLOY_COMMIT);
    expect(found.exact).to.equal(true);
    expect(found.input.sources["contracts/cre/CollectionsReceiver.sol"].content).to.not.include("simulation transmitter guard, as all three");

    // With no commit to try, today's still verify it (same executable code).
    const fallback = await verificationInput(hre, { fqn, address, commit: null });
    expect(fallback).to.include({ from: "today", exact: false });

    // And today's build of it stays on today's sources.
    const current = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(...args);
    expect((await sourcesFor(hre, { fqn, address: await current.getAddress(), commit: DEPLOY_COMMIT })).from).to.equal("today");
  });

  it("knows the commit it is at, and whether the contracts are committed", () => {
    const { commit, dirty } = headSource();
    expect(commit).to.match(/^[0-9a-f]{40}$/);
    expect(typeof dirty).to.equal("boolean");
  });
});

describe("what verify:monad submits (lib/verify.js)", function () {
  this.timeout(300_000);

  it("verifies every contract in the Monad record, and the GuardianReceiver the redeploy replaced", () => {
    const record = require("../../deployments/monad-testnet.json");
    const targets = verificationTargets(record);
    const names = targets.map((t) => t.name);
    for (const name of Object.keys(record.contracts)) expect(names).to.include(name);
    expect(targets.find((t) => t.name === "Stablecoin").artifact).to.equal("MockAUSD");

    const old = targets.find((t) => t.name === "GuardianReceiver (replaced)");
    expect(old).to.include({
      artifact: "GuardianReceiver",
      address: "0xF8259426519d7908e7AF63f20aea3FfCF52426D8",
      txHash: "0xe717c54d4ce41e4164ded7ddbb31e65a40c666ec94b4d056842d2dd0f35f2369",
      commit: DEPLOY_COMMIT,
      current: false,
      replacedBy: record.contracts.GuardianReceiver.address,
    });
    expect(old.args).to.equal(null, "read from its creation transaction");
    expect(targets.find((t) => t.name === "GuardianReceiver").commit).to.equal(record.contracts.GuardianReceiver.sourceCommit);
    expect(targets.find((t) => t.name === "PolarisCheckout").commit).to.equal(DEPLOY_COMMIT);
    for (const t of targets) expect(t.txHash, t.name).to.match(/^0x[0-9a-f]{64}$/);

    // A real stablecoin is not ours to verify.
    const real = { ...record, contracts: { ...record.contracts, Stablecoin: { address: record.contracts.Stablecoin.address } }, redeploys: [] };
    expect(verificationTargets(real).map((t) => t.name)).to.not.include("Stablecoin");
  });

  it("reads constructor arguments back from the creation transaction", async () => {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("CollateralVault");
    const token = ethers.Wallet.createRandom().address;
    const vault = await factory.deploy(owner.address, token);
    const tx = await ethers.provider.getTransaction(vault.deploymentTransaction().hash);
    const expected = factory.interface.encodeDeploy([owner.address, token]);
    expect(argsFromCreation(tx.data, factory.bytecode)).to.equal(expected);

    // The same code with other metadata (a rebuild that reproduces only the executable code) still reads them.
    const code = factory.bytecode;
    const metaLen = (parseInt(code.slice(-4), 16) + 2) * 2;
    const otherMeta = code.slice(0, code.length - metaLen) + "ff".repeat(metaLen / 2 - 2) + code.slice(-4);
    expect(argsFromCreation(tx.data, otherMeta)).to.equal(expected);

    // Other code is refused.
    const other = (await ethers.getContractFactory("BatchSettlement")).bytecode;
    expect(() => argsFromCreation(tx.data, other)).to.throw(/does not carry this contract's creation code|shorter/);

    // No arguments: nothing past the code.
    const ausd = await ethers.getContractFactory("MockAUSD");
    const deployed = await ausd.deploy();
    const t2 = await ethers.provider.getTransaction(deployed.deploymentTransaction().hash);
    expect(argsFromCreation(t2.data, ausd.bytecode)).to.equal("0x");
  });

  it("submits only the files a contract is built from, when they alone reproduce it", async () => {
    const [owner] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("CollateralVault")).deploy(owner.address, ethers.Wallet.createRandom().address);
    const fqn = "contracts/CollateralVault.sol:CollateralVault";
    const found = await verificationInput(hre, { fqn, address: await vault.getAddress(), commit: null });
    expect(found.from).to.equal("today");
    expect(found.reduced).to.equal(true);
    expect(found.exact).to.equal(true);
    const files = Object.keys(found.input.sources);
    expect(files).to.include("contracts/CollateralVault.sol");
    expect(files).to.not.include("contracts/PolarisCheckout.sol");
    expect(files.some((f) => f.startsWith("@openzeppelin/contracts/"))).to.equal(true);
    expect(found.solcLongVersion).to.match(/^0\.8\.24\+commit\./);
    expect(found.input.settings.optimizer).to.deep.equal({ enabled: true, runs: 200 });
    expect(found.input.settings.evmVersion).to.equal("cancun");

    // closureInput refuses metadata naming a file the input lacks.
    const buildInfo = await hre.artifacts.getBuildInfo(fqn);
    const meta = JSON.stringify({ sources: { "contracts/Nope.sol": {} } });
    expect(() => closureInput(buildInfo.input, meta)).to.throw(/Nope\.sol/);
  });

  it("rebuilds the deploy commit's PolarisCheckout, cut down to its own files", async function () {
    if (!haveCommit(DEPLOY_COMMIT)) this.skip();
    const { input, solcVersion } = await standardInputAt(hre, CHECKOUT, DEPLOY_COMMIT);
    const old = await compileFor(hre, input, solcVersion, CHECKOUT);
    const [owner, treasury] = await ethers.getSigners();
    const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, ausd, scores, treasury.address, 3600, 60);
    const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, ausd, treasury.address, 60);
    const args = [owner.address, await engine.getAddress(), await payments.getAddress(), await scores.getAddress()];
    const deployed = await new ethers.ContractFactory(old.abi, old.bytecode, owner).deploy(...args);

    const found = await verificationInput(hre, { fqn: CHECKOUT, address: await deployed.getAddress(), commit: DEPLOY_COMMIT });
    expect(found.from).to.equal(DEPLOY_COMMIT);
    expect(found.reduced).to.equal(true);
    expect(found.exact).to.equal(true);
    expect(found.input.sources["contracts/PolarisCheckout.sol"].content).to.not.include("reauthorizedThrough");
    expect(Object.keys(found.input.sources)).to.not.include("contracts/PolarisSend.sol");
    const tx = await ethers.provider.getTransaction(deployed.deploymentTransaction().hash);
    expect(argsFromCreation(tx.data, found.bytecode)).to.equal(new ethers.Interface(found.abi).encodeDeploy(args));
  });
});

describe("Monadscan through Etherscan V2 (lib/monadscan.js)", () => {
  /** A stand-in fetch: answers from `script` in order and keeps every request. */
  function fakeFetch(script) {
    const calls = [];
    const fn = async (url, init = {}) => {
      calls.push({ url: new URL(url), init });
      const body = script.shift();
      if (!body) throw new Error("unexpected request");
      return { ok: true, status: 200, json: async () => body };
    };
    return { fn, calls };
  }

  it("puts chainid 10143 on every call, and reads getsourcecode", async () => {
    const { fn, calls } = fakeFetch([
      { status: "1", message: "OK", result: [{ SourceCode: "", ContractName: "", CompilerVersion: "" }] },
      { status: "1", message: "OK", result: [{ SourceCode: "{{...}}", ContractName: "PolarisCheckout", CompilerVersion: "v0.8.24+commit.e11b9ed9", OptimizationUsed: "1", Runs: "200", EVMVersion: "cancun" }] },
    ]);
    const scan = monadscan({ apiKey: "k", fetch: fn });
    expect((await scan.sourceOf("0x01")).verified).to.equal(false);
    expect(await scan.sourceOf("0x02")).to.include({ verified: true, name: "PolarisCheckout", compilerVersion: "v0.8.24+commit.e11b9ed9", optimizationUsed: true, runs: 200, evmVersion: "cancun" });
    for (const c of calls) {
      expect(`${c.url.origin}${c.url.pathname}`).to.equal(ETHERSCAN_V2_API);
      expect(c.url.searchParams.get("chainid")).to.equal("10143");
      expect(c.url.searchParams.get("action")).to.equal("getsourcecode");
    }
  });

  it("submits standard JSON with the arguments and compiler Etherscan expects, then polls to a verdict", async () => {
    const { fn, calls } = fakeFetch([
      { status: "1", message: "OK", result: "guid-1" },
      { status: "0", message: "NOTOK", result: "Pending in queue" },
      { status: "0", message: "NOTOK", result: "Max rate limit reached" },
      { status: "1", message: "OK", result: "Pass - Verified" },
    ]);
    const scan = monadscan({ apiKey: "k", fetch: fn, pollMs: 1 });
    const input = { language: "Solidity", sources: { "contracts/A.sol": { content: "" } }, settings: {} };
    const guid = await scan.submit({ address: "0xabc", input, contractName: "contracts/A.sol:A", compilerVersion: "0.8.24+commit.e11b9ed9", constructorArguments: "0x00ff" });
    expect(guid).to.equal("guid-1");
    const post = calls[0];
    expect(post.init.method).to.equal("POST");
    expect(post.url.searchParams.get("chainid")).to.equal("10143");
    const body = new URLSearchParams(post.init.body);
    expect(body.get("action")).to.equal("verifysourcecode");
    expect(body.get("codeformat")).to.equal("solidity-standard-json-input");
    expect(body.get("contractname")).to.equal("contracts/A.sol:A");
    expect(body.get("compilerversion")).to.equal("v0.8.24+commit.e11b9ed9");
    expect(body.get("constructorArguements")).to.equal("00ff");
    expect(JSON.parse(body.get("sourceCode"))).to.deep.equal(input);

    expect(await scan.waitFor(guid)).to.equal("verified");
    for (const c of calls.slice(1)) {
      expect(c.url.searchParams.get("chainid")).to.equal("10143");
      expect(c.url.searchParams.get("action")).to.equal("checkverifystatus");
    }
  });

  it("takes 'already verified' as done, and a failure as a failure", async () => {
    const already = fakeFetch([{ status: "0", message: "NOTOK", result: "Contract source code already verified" }]);
    expect(await monadscan({ apiKey: "k", fetch: already.fn }).submit({ address: "0x1", input: {}, contractName: "a:A", compilerVersion: "v0.8.24" })).to.equal(null);

    const fail = fakeFetch([{ status: "0", message: "NOTOK", result: "Fail - Unable to verify. Compiled contract deployment bytecode does NOT match" }]);
    let err;
    try {
      await monadscan({ apiKey: "k", fetch: fail.fn, pollMs: 1 }).waitFor("g");
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.match(/Unable to verify/);
    expect(() => monadscan({ apiKey: "" })).to.throw(/API key/);
  });

  it("writes the verification record: address, name, verified, explorer link, compiler", () => {
    const record = { network: "monadTestnet", chainId: 10143, explorer: "https://testnet.monadscan.com" };
    const out = verificationRecord({
      record,
      checkedAt: "2026-09-28T00:00:00.000Z",
      entries: [
        {
          target: { name: "PolarisCheckout", address: "0x3874ef1bcE222755525a96f8284631780b9bC70B", commit: DEPLOY_COMMIT, current: true },
          fqn: CHECKOUT,
          explorer: { verified: true, name: "PolarisCheckout", compilerVersion: "v0.8.24+commit.e11b9ed9", optimizationUsed: true, runs: 200, evmVersion: "cancun" },
          local: { from: DEPLOY_COMMIT, solcLongVersion: "0.8.24+commit.e11b9ed9", exact: true },
        },
        {
          target: { name: "GuardianReceiver (replaced)", address: "0xF8259426519d7908e7AF63f20aea3FfCF52426D8", commit: DEPLOY_COMMIT, current: false, replacedBy: "0x4c99136634F670cd59E73fc284fED164C662e3Df" },
          fqn: "contracts/cre/GuardianReceiver.sol:GuardianReceiver",
          explorer: { verified: false, name: null, compilerVersion: null },
        },
      ],
    });
    expect(out).to.include({ chainId: 10143, verified: 1, total: 2, api: `${ETHERSCAN_V2_API}?chainid=10143` });
    expect(out.contracts[0]).to.include({
      name: "PolarisCheckout",
      address: "0x3874ef1bcE222755525a96f8284631780b9bC70B",
      verified: true,
      explorerUrl: "https://testnet.monadscan.com/address/0x3874ef1bcE222755525a96f8284631780b9bC70B#code",
      compilerVersion: "v0.8.24+commit.e11b9ed9",
      sourceCommit: DEPLOY_COMMIT,
      optimizer: "enabled, 200 runs",
    });
    expect(out.contracts[1]).to.include({ verified: false, current: false, replacedBy: "0x4c99136634F670cd59E73fc284fED164C662e3Df", compilerVersion: null });
    expect(codeUrl("https://testnet.monadscan.com/", "0x1")).to.equal("https://testnet.monadscan.com/address/0x1#code");
  });

  it("the committed verification record covers every contract verify:monad targets, each verified", () => {
    const record = require("../../deployments/monad-testnet.json");
    const out = require("../../deployments/monad-testnet.verification.json");
    const targets = verificationTargets(record);
    expect(out).to.include({ chainId: record.chainId, explorer: record.explorer, total: targets.length, verified: targets.length });
    expect(out.contracts.map((c) => c.address)).to.deep.equal(targets.map((t) => t.address));
    for (const c of out.contracts) {
      expect(c.verified, c.name).to.equal(true);
      expect(c.explorerUrl).to.equal(codeUrl(record.explorer, c.address));
      expect(c.compilerVersion, c.name).to.match(/^v0\.8\.24\+commit\.[0-9a-f]{8}$/);
      expect(c.sourceCommit, c.name).to.match(/^[0-9a-f]{40}$/);
    }
    expect(out.contracts.find((c) => c.name === "PolarisCheckout").sources).to.equal(`commit ${DEPLOY_COMMIT}`);
  });

  it("gives hardhat-verify one key, so it speaks V2 with chainid 10143 too", () => {
    const { Etherscan } = require("@nomicfoundation/hardhat-verify/etherscan");
    const { apiKey, customChains } = hre.config.etherscan;
    expect(typeof apiKey).to.equal("string", "an object puts hardhat-verify on V1, which drops chainid");
    const chain = customChains.find((c) => c.network === "monadTestnet");
    expect(chain).to.deep.include({ chainId: 10143 });
    expect(chain.urls.browserURL).to.equal("https://testnet.monadscan.com");
    const client = Etherscan.fromChainConfig(apiKey === "" ? "placeholder" : apiKey, chain);
    expect(client.chainId).to.equal(10143);
    expect(client.apiUrl).to.equal(ETHERSCAN_V2_API);
  });
});
