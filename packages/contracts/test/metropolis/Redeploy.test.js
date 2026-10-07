/**
 * lib/redeploy.js (scripts/redeploy-guardian.js, `redeploy-guardian:monad`):
 * replacing the GuardianReceiver that Monad testnet runs (built at the deploy
 * commit) with today's, and nothing else. Here the deploy commit's
 * GuardianReceiver is rebuilt from git and put in a local deployment's place,
 * as it is on testnet; then it is replaced, and the deployment read back.
 */
const { expect } = require("chai");
const { execFileSync } = require("node:child_process");
const hre = require("hardhat");
const { ethers } = hre;

const { deployPolaris, USD } = require("../../lib/deploy");
const { checkDeployment } = require("../../lib/check");
const { redeployGuardian, runsTodaysGuardian } = require("../../lib/redeploy");
const { compileFor, repoRoot, standardInputAt } = require("../../lib/verify");
const cre = require("../../lib/cre");

const DEPLOY_COMMIT = "020484b2aea74bde3f2cbc918d534dbda1348723";
const FQN = "contracts/cre/GuardianReceiver.sol:GuardianReceiver";

function haveCommit(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot() });
    return true;
  } catch {
    return false;
  }
}

describe("redeploy-guardian (lib/redeploy.js)", function () {
  this.timeout(300_000);
  let record, deployer, transmitter, stranger;

  before(function () {
    if (!haveCommit(DEPLOY_COMMIT)) this.skip();
  });

  beforeEach(async () => {
    [deployer, , transmitter, stranger] = await ethers.getSigners();
    record = await deployPolaris(hre, {
      tokenMode: "mock",
      treasury: deployer.address,
      graceSeconds: 120,
      minInterval: 60,
      minPeriod: 60,
      forwarderKind: "local",
      simulationTransmitter: transmitter.address,
      demoMerchant: ethers.Wallet.createRandom(),
      poolSeed: USD(10_000),
    });
    // What Monad testnet runs: the deploy commit's GuardianReceiver, asked by PolarisCheckout.
    const { input, solcVersion } = await standardInputAt(hre, FQN, DEPLOY_COMMIT);
    const old = await compileFor(hre, input, solcVersion, FQN);
    const legacy = { minPrice: 99_500_000n, minFreeCash: USD(1_000), maxBadDebtBps: 500, maxPriceAge: 7_200 };
    const guardian = await new ethers.ContractFactory(old.abi, old.bytecode, deployer).deploy(
      record.cre.forwarder,
      record.contracts.PolarisLoanEngine.address,
      transmitter.address,
      legacy,
      3_600
    );
    const address = await guardian.getAddress();
    await (await ethers.getContractAt("PolarisCheckout", record.contracts.PolarisCheckout.address)).setCreditGuardian(address);
    record.contracts.GuardianReceiver = { ...record.contracts.GuardianReceiver, address, sourceCommit: DEPLOY_COMMIT };
    record.roles.creditGuardian = address;
    record.cre.workflows.guardian.receiver = address;
    record.cre.workflows.guardian.feed.address = address;
    record.config.guardian = { ...legacy, minPrice: "99500000", minFreeCash: "1000000000", maxAttestationAge: 3600 };
    expect(await runsTodaysGuardian(hre, address)).to.equal(false);
  });

  it("deploys today's GuardianReceiver, points PolarisCheckout at it, and the record reads back whole", async () => {
    const old = record.contracts.GuardianReceiver.address;
    const { record: next, txs } = await redeployGuardian(hre, record, { why: "test", allowDirty: true });
    const address = next.contracts.GuardianReceiver.address;
    expect(address).to.not.equal(old);
    expect(await runsTodaysGuardian(hre, address)).to.equal(true);
    expect(txs.map((t) => t.call)).to.deep.equal(["deploy", `setCreditGuardian(${address})`]);

    const checkout = await ethers.getContractAt("PolarisCheckout", next.contracts.PolarisCheckout.address);
    expect(await checkout.creditGuardian()).to.equal(address);
    const g = await ethers.getContractAt("GuardianReceiver", address);
    expect(await g.pool()).to.equal(next.contracts.PolarisLoanEngine.address);
    expect(await g.simulationTransmitter()).to.equal(transmitter.address);
    expect(await g.getForwarderAddress()).to.equal(next.cre.forwarder);
    expect(await g.thresholds()).to.deep.equal(cre.GUARDIAN_THRESHOLD_FIELDS.map((f) => BigInt(cre.GUARDIAN_DEFAULTS[f])));
    // The pool now answers for itself: $10,000 of free cash, nothing lent.
    expect(await checkout.creditPaused()).to.deep.equal([false, 0n]);

    expect(next.roles.creditGuardian).to.equal(address);
    expect(next.cre.workflows.guardian).to.include({ receiver: address });
    expect(next.cre.workflows.guardian.feed.address).to.equal(address);
    expect(next.cre.workflows.guardian.view).to.match(/acknowledgedBadDebt/);
    expect(next.config.guardian).to.include({ maxPrice: "100500000", minOriginated: "10000000000", maxAttestationAge: 3600 });
    expect(next.contracts.GuardianReceiver.sourceCommit).to.match(/^[0-9a-f]{40}$/);
    expect(next.redeploys).to.have.length(1);
    expect(next.redeploys[0]).to.include({ contract: "GuardianReceiver", address, why: "test" });
    expect(next.redeploys[0].replaced).to.include({ address: old, sourceCommit: DEPLOY_COMMIT });
    // The input record is left as it was.
    expect(record.contracts.GuardianReceiver.address).to.equal(old);

    // check:deployment agrees with the new record on every row.
    const failed = (await checkDeployment(ethers, next)).filter((r) => !r.ok).map((r) => r.what);
    expect(failed).to.deep.equal([]);

    // And there is nothing left to replace.
    let err;
    try {
      await redeployGuardian(hre, next, { allowDirty: true });
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.match(/already runs today's code/);
  });

  it("refuses a signer who does not own PolarisCheckout, before sending anything", async () => {
    const asStranger = { ...hre, ethers: { ...ethers, getSigners: async () => [stranger] } };
    const nonce = await ethers.provider.getTransactionCount(stranger.address);
    let err;
    try {
      await redeployGuardian(asStranger, record, { allowDirty: true });
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.match(/PolarisCheckout is owned by/);
    expect(await ethers.provider.getTransactionCount(stranger.address)).to.equal(nonce);
  });
});
