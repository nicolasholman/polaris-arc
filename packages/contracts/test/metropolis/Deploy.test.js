/**
 * lib/deploy.js, run in-process exactly as scripts/deploy-monad.js runs it on
 * Monad testnet (with MockAUSD and a local forwarder in place of AUSD and
 * Chainlink's). Every role the protocol depends on is checked here, so a
 * deployment cannot come out with the checkout unable to originate, the
 * receiver unable to underwrite, or anyone but the checkout able to open a
 * plan.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const { deployPolaris, USD } = require("../../lib/deploy");
const cre = require("../../lib/cre");

describe("deploy-monad (in process)", () => {
  let record, deployer, relayer, merchant;
  const at = (name) => ethers.getContractAt(name, record.contracts[name].address);

  before(async () => {
    [deployer, relayer] = await ethers.getSigners();
    merchant = ethers.Wallet.createRandom();
    record = await deployPolaris(hre, {
      tokenMode: "mock",
      treasury: deployer.address,
      graceSeconds: 120,
      minInterval: 60,
      minPeriod: 60,
      forwarderKind: "local",
      simulationTransmitter: deployer.address,
      relayer: relayer.address,
      demoMerchant: merchant,
      poolSeed: USD(100_000),
    });
  });

  it("records every contract with its address, block, transaction and an ABI that exists", async () => {
    const names = [
      "Stablecoin", "ScoreManager", "PolarisLoanEngine", "PolarisPayments", "MerchantRegistry", "CollateralVault",
      "BatchSettlement", "PolarisSend", "PolarisSplit", "PolarisCheckout", "MockKeystoneForwarder", "CollectionsReceiver", "UnderwritingReceiver",
      "GuardianReceiver", "MockAusdUsdFeed",
    ];
    expect(Object.keys(record.contracts)).to.have.members(names);
    for (const n of names) {
      const c = record.contracts[n];
      expect(ethers.isAddress(c.address), n).to.equal(true);
      expect(await ethers.provider.getCode(c.address), n).to.not.equal("0x");
      expect(c.blockNumber, n).to.be.a("number");
      expect(c.txHash, n).to.match(/^0x[0-9a-f]{64}$/);
      expect(existsSync(join(__dirname, "..", "..", c.abi)), `${n} ${c.abi}`).to.equal(true);
      expect(c.args, `${n} constructor args`).to.be.an("array");
    }
    expect(record.contracts.GuardianReceiver.args[0]).to.equal(record.contracts.MockKeystoneForwarder.address);
    expect(record.chainId).to.equal(31337);
  });

  it("makes PolarisCheckout the only originator, and the payments' only checkout", async () => {
    const engine = await at("PolarisLoanEngine");
    expect(await engine.isOriginator(record.contracts.PolarisCheckout.address)).to.equal(true);
    for (const who of [deployer.address, relayer.address, record.contracts.CollectionsReceiver.address]) {
      expect(await engine.isOriginator(who)).to.equal(false);
    }
    expect(await (await at("PolarisPayments")).checkout()).to.equal(record.contracts.PolarisCheckout.address);
    expect(record.roles.loanEngineOriginators).to.deep.equal([record.contracts.PolarisCheckout.address]);
  });

  it("lets only the engine write scores and only the underwriting receiver underwrite, and requires underwriting", async () => {
    const scores = await at("ScoreManager");
    expect(await scores.isWriter(record.contracts.PolarisLoanEngine.address)).to.equal(true);
    expect(await scores.isWriter(deployer.address)).to.equal(false);
    expect(await scores.isUnderwriter(record.contracts.UnderwritingReceiver.address)).to.equal(true);
    expect(await scores.isUnderwriter(deployer.address)).to.equal(false);
    expect(await scores.isUnderwriter(record.contracts.CollectionsReceiver.address)).to.equal(false);
    expect(await scores.requireUnderwriting()).to.equal(true);
    expect(await scores.collateralVault()).to.equal(record.contracts.CollateralVault.address);
  });

  it("wires the vault, the registry and the CRE receivers to the forwarder", async () => {
    const vault = await at("CollateralVault");
    const engine = await at("PolarisLoanEngine");
    expect(await vault.loanEngine()).to.equal(record.contracts.PolarisLoanEngine.address);
    expect(await vault.isSeizer(record.contracts.PolarisLoanEngine.address)).to.equal(true);
    expect(await engine.collateralVault()).to.equal(record.contracts.CollateralVault.address);
    expect(await engine.merchantRegistry()).to.equal(record.contracts.MerchantRegistry.address);
    for (const r of ["CollectionsReceiver", "UnderwritingReceiver", "GuardianReceiver"]) {
      expect(await (await at(r)).getForwarderAddress(), r).to.equal(record.contracts.MockKeystoneForwarder.address);
      expect(await (await at(r)).simulationTransmitter(), r).to.equal(deployer.address);
    }
    expect(record.cre.workflows.collections.nameBytes10).to.equal(cre.workflowNameBytes10("polaris-collections"));
  });

  it("deploys the guardian with decision 9's thresholds (and the review's ceiling and floor) and makes it the checkout's credit guard", async () => {
    const guardian = await at("GuardianReceiver");
    expect(await (await at("PolarisCheckout")).creditGuardian()).to.equal(record.contracts.GuardianReceiver.address);
    expect(record.roles.creditGuardian).to.equal(record.contracts.GuardianReceiver.address);
    expect(await guardian.pool()).to.equal(record.contracts.PolarisLoanEngine.address);
    const t = await guardian.thresholds();
    expect([t.minPrice, t.maxPrice, t.minFreeCash, t.maxBadDebtBps, t.minOriginated, t.maxPriceAge]).to.deep.equal([
      99_500_000n,
      100_500_000n,
      USD(1_000),
      500n,
      USD(10_000),
      7_200n,
    ]);
    expect(await guardian.maxAttestationAge()).to.equal(3_600n);
    expect(record.config.guardian).to.deep.equal({
      minPrice: "99500000",
      maxPrice: "100500000",
      minFreeCash: "1000000000",
      maxBadDebtBps: 500,
      minOriginated: "10000000000",
      maxPriceAge: 7200,
      maxAttestationAge: 3600,
    });
    // The record's view line is the ABI's: what the workflow decodes currentInputs() with.
    expect(record.cre.workflows.guardian.view).to.equal(
      "currentInputs() returns ((uint256 freeCash,uint256 totalOwed,uint256 badDebt,uint256 totalOriginated) state, " +
        "(int256 minPrice,int256 maxPrice,uint256 minFreeCash,uint16 maxBadDebtBps,uint256 minOriginated,uint32 maxPriceAge) limits, uint256 acknowledgedBadDebt)"
    );
    const fn = guardian.interface.getFunction("currentInputs");
    expect(fn.outputs.map((o) => o.format("full"))).to.deep.equal([
      "(uint256 freeCash, uint256 totalOwed, uint256 badDebt, uint256 totalOriginated) state",
      "(int256 minPrice, int256 maxPrice, uint256 minFreeCash, uint16 maxBadDebtBps, uint256 minOriginated, uint32 maxPriceAge) limits",
      "uint256 acknowledgedBadDebt",
    ]);
    // No attestation yet: Pay in 4 is open (fail open).
    expect(await (await at("PolarisCheckout")).creditPaused()).to.deep.equal([false, 0n]);

    const g = record.cre.workflows.guardian;
    expect(g.name).to.equal("polaris-guardian");
    expect(g.nameBytes10).to.equal(cre.workflowNameBytes10("polaris-guardian"));
    expect(g.receiver).to.equal(record.contracts.GuardianReceiver.address);
    expect(g.pool).to.equal(record.contracts.PolarisLoanEngine.address);
    expect(g.reasons).to.deep.equal({ DEPEG: 1, LOW_CASH: 2, BAD_DEBT: 4, STALE_PRICE: 8, OWNER_PAUSE: 128 });
    // A local chain reads a labelled stand-in; testnet records Chainlink's mainnet feed.
    expect(g.priceFeed).to.include({ kind: "mock", address: record.contracts.MockAusdUsdFeed.address, decimals: 8 });
    const feed = await ethers.getContractAt("MockPriceFeed", record.contracts.MockAusdUsdFeed.address);
    expect((await feed.latestRoundData())[1]).to.equal(99_980_000n);
    expect(g.feed.description).to.equal(await guardian.description());

    const retry = record.cre.workflows.collections.retry;
    expect(retry.contract).to.equal(record.contracts.PolarisCheckout.address);
    expect(retry.topic0).to.equal((await at("PolarisCheckout")).interface.getEvent("Reauthorized").topicHash);
  });

  it("gives the relayer its operator roles and nothing that moves money", async () => {
    expect(await (await at("PolarisPayments")).isOperator(relayer.address)).to.equal(true);
    expect(await (await at("MerchantRegistry")).isOperator(relayer.address)).to.equal(true);
    expect(await (await at("BatchSettlement")).isSettler(relayer.address)).to.equal(true);
    expect(await (await at("PolarisLoanEngine")).isOriginator(relayer.address)).to.equal(false);
    expect(await (await at("PolarisLoanEngine")).owner()).to.equal(deployer.address);
  });

  it("registers the demo merchant by its own signature, activates it, and publishes its plans", async () => {
    const m = await (await at("MerchantRegistry")).merchantOf(merchant.address);
    expect(m.name).to.equal("Polaris Demo Studio");
    expect(m.payoutAddress).to.equal(merchant.address);
    expect(m.active).to.equal(true);
    expect(m.maxOrderValue).to.equal(USD(1_000));
    const payments = await at("PolarisPayments");
    for (const p of record.demo.subscriptionPlans) {
      const plan = await payments.getPlan(p.planId);
      expect(plan.merchant).to.equal(merchant.address);
      expect(plan.pricePerPeriod.toString()).to.equal(p.pricePerPeriod);
      expect(plan.periodSeconds.toString()).to.equal(p.periodSeconds);
    }
  });

  it("seeds the credit pool", async () => {
    const token = await ethers.getContractAt("MockAUSD", record.contracts.Stablecoin.address);
    expect(await token.balanceOf(record.contracts.PolarisLoanEngine.address)).to.equal(USD(100_000));
    expect(record.demo.poolSeeded).to.equal(USD(100_000).toString());
  });

  it("sends every transaction with its own estimate plus 15%, never a blanket limit (Monad bills the limit)", async () => {
    const tx = require("../../lib/tx");
    expect(tx.withHeadroom(100_000n)).to.equal(115_000n);
    const scores = await at("ScoreManager");
    const estimate = await scores.setWriter.estimateGas(relayer.address, false);
    const receipt = await tx.send(scores, "setWriter", [relayer.address, false]);
    const sent = await ethers.provider.getTransaction(receipt.hash);
    expect(sent.gasLimit).to.equal((estimate * 115n) / 100n);
    const deployment = await ethers.provider.getTransaction(record.contracts.PolarisCheckout.txHash);
    expect(deployment.gasLimit).to.be.lessThan(5_000_000n);
    expect(deployment.gasLimit).to.be.greaterThan(BigInt(record.contracts.PolarisCheckout.gasUsed));
  });

  it("publishes the EIP-712 domains clients sign under", async () => {
    expect(record.eip712.PolarisCheckout.domain).to.deep.equal({
      name: "PolarisCheckout",
      version: "1",
      chainId: 31337,
      verifyingContract: record.contracts.PolarisCheckout.address,
    });
    expect(record.eip712.Stablecoin.domain.name).to.equal("Agora Dollar");
    expect(record.eip712.PolarisCheckout.types.PlanIntent.map((f) => f.name)).to.deep.equal([
      "buyer", "merchant", "principal", "installments", "interval", "orderId", "nonce", "deadline",
    ]);
    // Everything in the record serialises.
    expect(() => JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v))).to.not.throw();
  });
});

describe("the guardian's configuration from the environment", () => {
  const { guardianConfig } = require("../../scripts/deploy-monad");

  it("defaults to decision 9 and 10, the $1.005 ceiling and the $10,000 floor for the bad-debt ratio", () => {
    expect(guardianConfig({})).to.deep.equal({
      guardianThresholds: {
        minPrice: 99_500_000n,
        maxPrice: 100_500_000n,
        minFreeCash: 1_000_000_000n,
        maxBadDebtBps: 500,
        minOriginated: 10_000_000_000n,
        maxPriceAge: 7_200,
      },
      maxAttestationAge: 3_600,
    });
  });

  it("reads dollars for the peg and the cash floor, and whole numbers for the rest", () => {
    const c = guardianConfig({
      GUARD_MIN_PRICE: "1.001",
      GUARD_MAX_PRICE: "1.01",
      GUARD_MIN_FREE_CASH_AUSD: "250.5",
      GUARD_MAX_BAD_DEBT_BPS: "200",
      GUARD_MIN_ORIGINATED_AUSD: "5000",
      GUARD_MAX_PRICE_AGE_SECONDS: "3600",
      GUARD_MAX_ATTESTATION_AGE_SECONDS: "900",
    });
    expect(c).to.deep.equal({
      guardianThresholds: {
        minPrice: 100_100_000n,
        maxPrice: 101_000_000n,
        minFreeCash: 250_500_000n,
        maxBadDebtBps: 200,
        minOriginated: 5_000_000_000n,
        maxPriceAge: 3_600,
      },
      maxAttestationAge: 900,
    });
    expect(() => guardianConfig({ GUARD_MAX_BAD_DEBT_BPS: "5%" })).to.throw(/GUARD_MAX_BAD_DEBT_BPS/);
  });
});

describe("the CRE simulation transmitter", () => {
  // Behind Chainlink's public simulation forwarder, tx.origin is the
  // underwriting receiver's only guard: whatever the transmitter's key calls
  // can deliver credit facts. So on a public network it is a dedicated key.
  const { simulationTransmitterFor } = require("../../scripts/deploy-monad");
  const creKey = ethers.Wallet.createRandom();
  let deployer;
  before(async () => {
    [deployer] = await ethers.getSigners();
  });
  const none = () => undefined;

  it("on the simulation forwarder, is the address of CRE_ETH_PRIVATE_KEY or CRE_SIMULATION_TRANSMITTER, and never defaults to the deployer", () => {
    expect(simulationTransmitterFor("simulation", deployer, {}, (n) => (n === "CRE_ETH_PRIVATE_KEY" ? creKey.privateKey.slice(2) : undefined)))
      .to.equal(creKey.address);
    expect(simulationTransmitterFor("simulation", deployer, { CRE_SIMULATION_TRANSMITTER: creKey.address.toLowerCase() }, none))
      .to.equal(creKey.address);
    expect(() => simulationTransmitterFor("simulation", deployer, {}, none)).to.throw(/dedicated CRE transmitter/);
  });

  it("refuses the deployer's key on the simulation forwarder, however it is given", () => {
    expect(() => simulationTransmitterFor("simulation", deployer, { CRE_SIMULATION_TRANSMITTER: deployer.address }, none))
      .to.throw(/must not be the deployer/);
    // Hardhat's first account: the deployer here, with its well-known key.
    const hardhatKey0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    expect(new ethers.Wallet(hardhatKey0).address).to.equal(deployer.address);
    expect(() => simulationTransmitterFor("simulation", deployer, {}, () => hardhatKey0)).to.throw(/must not be the deployer/);
  });

  it("is zero on the production forwarder, and the deployer by default on a local node", () => {
    expect(simulationTransmitterFor("production", deployer, { CRE_SIMULATION_TRANSMITTER: creKey.address }, none)).to.equal(ethers.ZeroAddress);
    expect(simulationTransmitterFor("local", deployer, {}, none)).to.equal(deployer.address);
    expect(simulationTransmitterFor("local", deployer, { CRE_SIMULATION_TRANSMITTER: creKey.address }, none)).to.equal(creKey.address);
  });

  it("deployPolaris refuses a simulation forwarder with the deployer, or nobody, as transmitter before sending anything", async () => {
    const cfg = {
      tokenMode: "mock",
      treasury: deployer.address,
      graceSeconds: 120,
      minInterval: 60,
      minPeriod: 60,
      forwarderKind: "simulation",
      forwarderAddress: ethers.Wallet.createRandom().address,
      demoMerchant: ethers.Wallet.createRandom(),
      poolSeed: USD(1),
    };
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    for (const simulationTransmitter of [deployer.address, ethers.ZeroAddress, undefined]) {
      let err;
      try {
        await deployPolaris(hre, { ...cfg, simulationTransmitter });
      } catch (e) {
        err = e;
      }
      expect(err, String(simulationTransmitter)).to.be.instanceOf(Error);
      expect(err.message).to.match(/simulation/);
    }
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce, "nothing was sent");
  });
});
