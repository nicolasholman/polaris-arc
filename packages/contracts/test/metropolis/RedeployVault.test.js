/**
 * lib/redeploy.js `redeployVault` (scripts/redeploy-vault.js,
 * `redeploy-vault:monad`): replacing an older CollateralVault with today's,
 * and nothing else. Two older vaults, each rebuilt from git and put in a
 * local deployment's place: the deploy commit's (no `lockWithPermit`), and the
 * one Monad testnet runs since its first vault redeploy (`lockWithPermit`, no
 * `withdrawWithSig`). Each is replaced, a borrower secures a line and takes it
 * out again without sending a transaction, and the deployment is read back.
 */
const { expect } = require("chai");
const { execFileSync } = require("node:child_process");
const hre = require("hardhat");
const { ethers } = hre;

const { deployPolaris, USD } = require("../../lib/deploy");
const { checkDeployment } = require("../../lib/check");
const { redeployVault, runsTodaysVault } = require("../../lib/redeploy");
const { compileFor, repoRoot, standardInputAt } = require("../../lib/verify");
const { signPermit } = require("../helpers/sign");
const { TYPES } = require("../../lib/eip712");

const DEPLOY_COMMIT = "020484b2aea74bde3f2cbc918d534dbda1348723";
// The CollateralVault on Monad testnet today (deployments/monad-testnet.json, contracts.CollateralVault.sourceCommit).
const TESTNET_VAULT_COMMIT = "20518d2b344afd2a92ad51f4da9b93c516f8df09";
const FQN = "contracts/CollateralVault.sol:CollateralVault";

function haveCommit(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot() });
    return true;
  } catch {
    return false;
  }
}

describe("redeploy-vault (lib/redeploy.js)", function () {
  this.timeout(300_000);
  let record, deployer, transmitter, borrower, stranger;

  before(function () {
    if (!haveCommit(DEPLOY_COMMIT) || !haveCommit(TESTNET_VAULT_COMMIT)) this.skip();
  });

  /** Put `commit`'s CollateralVault in the deployment's place, wired in, as an older vault is on testnet. */
  async function installLegacyVault(commit) {
    const { input, solcVersion } = await standardInputAt(hre, FQN, commit);
    const old = await compileFor(hre, input, solcVersion, FQN);
    const legacy = await new ethers.ContractFactory(old.abi, old.bytecode, deployer).deploy(deployer.address, record.contracts.Stablecoin.address);
    const address = await legacy.getAddress();
    const engine = await ethers.getContractAt("PolarisLoanEngine", record.contracts.PolarisLoanEngine.address);
    const scores = await ethers.getContractAt("ScoreManager", record.contracts.ScoreManager.address);
    await (await legacy.setLoanEngine(record.contracts.PolarisLoanEngine.address)).wait();
    await (await legacy.setSeizer(record.contracts.PolarisLoanEngine.address, true)).wait();
    await (await scores.setCollateralVault(address)).wait();
    await (await engine.setCollateralVault(address)).wait();
    record.contracts.CollateralVault = { ...record.contracts.CollateralVault, address, sourceCommit: commit };
    delete record.eip712.CollateralVault;
    expect(await runsTodaysVault(hre, address)).to.equal(false);
    return legacy;
  }

  beforeEach(async () => {
    [deployer, , transmitter, borrower, stranger] = await ethers.getSigners();
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
  });

  it("deploys today's vault, points ScoreManager and the loan engine at it, and a borrower secures a line gas-free", async () => {
    // The deploy commit's CollateralVault, wired in.
    await installLegacyVault(DEPLOY_COMMIT);
    const old = record.contracts.CollateralVault.address;
    const { record: next, txs } = await redeployVault(hre, record, { why: "test", allowDirty: true });
    const address = next.contracts.CollateralVault.address;
    expect(address).to.not.equal(old);
    expect(await runsTodaysVault(hre, address)).to.equal(true);
    expect(txs.map((t) => t.call)).to.deep.equal([
      "deploy",
      `setLoanEngine(${next.contracts.PolarisLoanEngine.address})`,
      `setSeizer(${next.contracts.PolarisLoanEngine.address}, true)`,
      `setCollateralVault(${address})`,
      `setCollateralVault(${address})`,
    ]);

    const scores = await ethers.getContractAt("ScoreManager", next.contracts.ScoreManager.address);
    const engine = await ethers.getContractAt("PolarisLoanEngine", next.contracts.PolarisLoanEngine.address);
    const vault = await ethers.getContractAt("CollateralVault", address);
    expect(await scores.collateralVault()).to.equal(address);
    expect(await engine.collateralVault()).to.equal(address);
    expect(await vault.loanEngine()).to.equal(next.contracts.PolarisLoanEngine.address);
    expect(await vault.isSeizer(next.contracts.PolarisLoanEngine.address)).to.equal(true);
    expect(await vault.owner()).to.equal(deployer.address);
    expect(await vault.creditMultiplierBps()).to.equal(15_000n);

    // A borrower with no MON: the permit is carried by someone else, and the line is secured.
    const token = await ethers.getContractAt("MockAUSD", next.contracts.Stablecoin.address);
    await (await token.mint(borrower.address, USD(300))).wait();
    const nonce = await ethers.provider.getTransactionCount(borrower.address);
    const p = await signPermit(token, borrower, address, USD(202));
    await (await vault.connect(stranger).lockWithPermit(borrower.address, USD(202), p.deadline, p.v, p.r, p.s)).wait();
    expect(await vault.lockedOf(borrower.address)).to.equal(USD(202));
    expect(await scores.creditLimitOf(borrower.address)).to.equal(USD(202));
    expect(await ethers.provider.getTransactionCount(borrower.address)).to.equal(nonce);

    expect(next.contracts.CollateralVault.sourceCommit).to.match(/^[0-9a-f]{40}$/);
    expect(next.contracts.CollateralVault.abi).to.equal("abi/CollateralVault.json");
    expect(next.redeploys.at(-1)).to.include({ contract: "CollateralVault", address, why: "test" });
    expect(next.redeploys.at(-1).replaced).to.include({ address: old, sourceCommit: DEPLOY_COMMIT });
    expect(record.contracts.CollateralVault.address).to.equal(old);

    const failed = (await checkDeployment(ethers, next)).filter((r) => !r.ok).map((r) => r.what);
    expect(failed).to.deep.equal([]);

    let err;
    try {
      await redeployVault(hre, next, { allowDirty: true });
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.match(/already runs today's code/);
  });

  it("replaces the vault testnet runs today: the record gains its Withdraw domain; old locks stay withdrawable by their owner only", async () => {
    // What Monad testnet runs: 20518d2's vault (lockWithPermit), with a smoke-test lock in it.
    const legacy = await installLegacyVault(TESTNET_VAULT_COMMIT);
    expect(legacy.interface.getFunction("withdrawWithSig")).to.equal(null);
    const token = await ethers.getContractAt("MockAUSD", record.contracts.Stablecoin.address);
    await (await token.mint(borrower.address, USD(300))).wait();
    const lp = await signPermit(token, borrower, await legacy.getAddress(), USD(25));
    await (await legacy.connect(stranger).lockWithPermit(borrower.address, USD(25), lp.deadline, lp.v, lp.r, lp.s)).wait();

    const old = record.contracts.CollateralVault.address;
    const { record: next } = await redeployVault(hre, record, { why: "withdraw by signature", allowDirty: true });
    const address = next.contracts.CollateralVault.address;
    const vault = await ethers.getContractAt("CollateralVault", address);
    const { chainId } = await ethers.provider.getNetwork();
    expect(next.eip712.CollateralVault).to.deep.equal({
      domain: { name: "CollateralVault", version: "1", chainId: Number(chainId), verifyingContract: address },
      types: TYPES.CollateralVault,
    });
    expect(record.eip712.CollateralVault).to.equal(undefined, "the input record is not mutated");
    expect(next.redeploys.at(-1).replaced).to.include({ address: old, sourceCommit: TESTNET_VAULT_COMMIT });

    // Nothing moved from the old vault: the lock is still there, it no longer counts toward the line,
    // and only the borrower's own transaction takes it out.
    const scores = await ethers.getContractAt("ScoreManager", next.contracts.ScoreManager.address);
    expect(await legacy.lockedOf(borrower.address)).to.equal(USD(25));
    expect(await scores.creditLimitOf(borrower.address)).to.equal(0n);

    // On the new vault: lock and take out again, the borrower sending nothing.
    const nonce = await ethers.provider.getTransactionCount(borrower.address);
    const p = await signPermit(token, borrower, address, USD(100));
    await (await vault.connect(stranger).lockWithPermit(borrower.address, USD(100), p.deadline, p.v, p.r, p.s)).wait();
    expect(await scores.creditLimitOf(borrower.address)).to.equal(USD(100));
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 600);
    const message = { borrower: borrower.address, amount: USD(40), nonce: await vault.nonces(borrower.address), deadline };
    const signature = await borrower.signTypedData(next.eip712.CollateralVault.domain, TYPES.CollateralVault, message);
    const before = await token.balanceOf(borrower.address);
    await (await vault.connect(stranger).withdrawWithSig(borrower.address, USD(40), deadline, signature)).wait();
    expect(await token.balanceOf(borrower.address)).to.equal(before + USD(40));
    expect(await vault.lockedOf(borrower.address)).to.equal(USD(60));
    expect(await ethers.provider.getTransactionCount(borrower.address)).to.equal(nonce);

    // The old vault's lock: out by the borrower's own call, which is the only way.
    await (await legacy.connect(borrower).withdraw(USD(25))).wait();
    expect(await legacy.lockedOf(borrower.address)).to.equal(0n);

    const failed = (await checkDeployment(ethers, next)).filter((r) => !r.ok).map((r) => r.what);
    expect(failed).to.deep.equal([]);
  });

  it("refuses a signer who does not own the loan engine and ScoreManager, before sending anything", async () => {
    await installLegacyVault(DEPLOY_COMMIT);
    const asStranger = { ...hre, ethers: { ...ethers, getSigners: async () => [stranger] } };
    const nonce = await ethers.provider.getTransactionCount(stranger.address);
    let err;
    try {
      await redeployVault(asStranger, record, { allowDirty: true });
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.match(/is owned by/);
    expect(await ethers.provider.getTransactionCount(stranger.address)).to.equal(nonce);
  });
});
