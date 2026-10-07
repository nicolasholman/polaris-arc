/**
 * lib/deploy.js, run in-process on the Hardhat network as NETWORK=local: every
 * contract deployed, every role granted and nothing more, the caps recorded,
 * and the record complete enough for the apps to run from.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const { deployPolaris, USD } = require("../../lib/deploy");
const { ARC_LOCAL, ARC_TESTNET, ARC_MAINNET, networkFor } = require("../../lib/networks");

describe("Deploying Polaris (lib/deploy.js)", function () {
  this.timeout(120_000);
  let record, deployer, keeper, relayer;

  before(async () => {
    [deployer, relayer, keeper] = await ethers.getSigners();
    record = await deployPolaris(hre, {
      network: ARC_LOCAL,
      tokenMode: "mock",
      treasury: deployer.address,
      keeper: keeper.address,
      relayer: relayer.address,
      graceSeconds: 3 * 24 * 3600,
      minInterval: 3600,
      minPeriod: 3600,
      demoMerchant: ethers.Wallet.createRandom(),
      poolSeed: USD(5_000),
    });
  });

  const at = (name, label = name) => ethers.getContractAt(name, record.contracts[label].address);

  it("deploys every contract, USDC and EURC send links included", async () => {
    for (const label of [
      "USDC", "EURC", "ScoreManager", "PolarisLoanEngine", "PolarisPayments", "MerchantRegistry", "CollateralVault",
      "BatchSettlement", "PolarisSend", "PolarisSendEURC", "PolarisSplit", "PolarisCheckout", "CollectionsReceiver",
      "UnderwritingReceiver", "CreditGuard",
    ]) {
      expect(record.contracts[label], label).to.not.equal(undefined);
      expect(await ethers.provider.getCode(record.contracts[label].address), label).to.not.equal("0x");
    }
    expect(await (await at("PolarisSend", "PolarisSendEURC")).stablecoin()).to.equal(record.contracts.EURC.address);
  });

  it("grants each role to exactly the contract or key that needs it", async () => {
    const scores = await at("ScoreManager");
    const engine = await at("PolarisLoanEngine");
    expect(await scores.isWriter(record.contracts.PolarisLoanEngine.address)).to.equal(true);
    expect(await scores.isUnderwriter(record.contracts.UnderwritingReceiver.address)).to.equal(true);
    expect(await scores.isUnderwriter(keeper.address)).to.equal(false);
    expect(await scores.requireUnderwriting()).to.equal(true);
    expect(await engine.isOriginator(record.contracts.PolarisCheckout.address)).to.equal(true);
    expect(await engine.isOriginator(relayer.address)).to.equal(false);
    expect(await (await at("CollectionsReceiver")).keeper()).to.equal(keeper.address);
    expect(await (await at("UnderwritingReceiver")).keeper()).to.equal(keeper.address);
    expect(await (await at("PolarisCheckout")).creditGuardian()).to.equal(record.contracts.CreditGuard.address);
    expect(await (await at("PolarisPayments")).isOperator(relayer.address)).to.equal(true);
    expect(await (await at("BatchSettlement")).isSettler(relayer.address)).to.equal(true);
  });

  it("funds the pool, leaves credit open, and records the caps and gas", async () => {
    const engine = await at("PolarisLoanEngine");
    expect((await engine.poolState()).freeCash).to.equal(USD(5_000));
    expect((await (await at("CreditGuard")).isCreditPaused())[0]).to.equal(false);
    expect(record.config.caps.sendMaxAmount).to.equal("10000000000");
    expect(record.config.caps.vaultMaxLockedPerUser).to.equal("10000000000");
    expect(BigInt(record.gas.totalUsed)).to.be.greaterThan(0n);
    expect(record.eip712.USDC.domain).to.deep.include({ name: "USDC", version: "2" });
    expect(record.eip712.EURC.domain).to.deep.include({ name: "EURC", version: "2" });
  });

  it("refuses a keeper that is the deployer, and a mock token off a local node", async () => {
    const base = { network: ARC_LOCAL, tokenMode: "mock", treasury: deployer.address, relayer: relayer.address, graceSeconds: 3600, minInterval: 60, minPeriod: 60, demoMerchant: ethers.Wallet.createRandom(), poolSeed: 0n };
    await expect(deployPolaris(hre, { ...base, keeper: deployer.address })).to.be.rejectedWith(/not the deployer/);
    await expect(deployPolaris(hre, { ...base, keeper: keeper.address, network: ARC_TESTNET })).to.be.rejectedWith(/local node only/);
  });

  it("knows Arc testnet and mainnet, and NETWORK picks between them", () => {
    expect(networkFor("testnet").chainId).to.equal(5042002);
    expect(networkFor("mainnet").chainId).to.equal(5042);
    expect(ARC_MAINNET.circle.usdc).to.equal(ARC_TESTNET.circle.usdc);
    expect(ARC_MAINNET.circle.tokenMessengerV2).to.not.equal(ARC_TESTNET.circle.tokenMessengerV2);
    expect(() => networkFor("monad")).to.throw(/Unknown NETWORK/);
  });
});
