/**
 * lib/lock.js (scripts/lock-receivers.js, `lock-receivers:monad`): after the
 * CRE workflows are deployed, each receiver accepts only its own workflow
 * (owner, name and id), then moves to the production forwarder and drops the
 * simulation transmitter, in that order.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const { deployPolaris, USD } = require("../../lib/deploy");
const { lockReceivers, applyLock, RECEIVERS, productionForwarderProblem, isLocalNetwork } = require("../../lib/lock");
const { MONAD_TESTNET } = require("../../lib/deploy");
const cre = require("../../lib/cre");

describe("lock-receivers (lib/lock.js)", () => {
  let record, deployer, workflowOwner, stranger, production;
  const ids = {
    CollectionsReceiver: ethers.id("polaris-collections deployed"),
    UnderwritingReceiver: ethers.id("polaris-underwrite deployed"),
    GuardianReceiver: ethers.id("polaris-guardian deployed"),
  };
  const at = (name) => ethers.getContractAt(name, record.contracts[name].address);

  beforeEach(async () => {
    [deployer, , , , workflowOwner, stranger] = await ethers.getSigners();
    record = await deployPolaris(hre, {
      tokenMode: "mock",
      treasury: deployer.address,
      graceSeconds: 120,
      minInterval: 60,
      minPeriod: 60,
      forwarderKind: "local",
      simulationTransmitter: deployer.address,
      demoMerchant: ethers.Wallet.createRandom(),
      poolSeed: USD(10_000),
    });
    // Stands in for Chainlink's production KeystoneForwarder on this local chain
    // (typeAndVersion "KeystoneForwarder ..."; test-only, it checks no signatures).
    production = await (await ethers.getContractFactory("TestKeystoneForwarder")).deploy();
  });

  async function deliver(forwarder, receiverName, body, { from = stranger, workflowId, owner = workflowOwner.address, name } = {}) {
    const raw = cre.encodeRawReport({
      body,
      workflowName: name,
      workflowOwner: owner,
      workflowId,
      executionId: ethers.hexlify(ethers.randomBytes(32)),
      timestamp: Math.floor(Date.now() / 1000),
    });
    await (await forwarder.connect(from).report(record.contracts[receiverName].address, raw, "0x", [])).wait();
    return { ok: (await forwarder.lastRevertData()) === "0x", revert: await forwarder.lastRevertData() };
  }

  it("locks every receiver to its workflow, then moves it to the production forwarder and clears the transmitter", async () => {
    const lock = await lockReceivers(hre, record, {
      workflowOwner: workflowOwner.address,
      workflowIds: ids,
      forwarderKind: "production",
      forwarderAddress: await production.getAddress(),
    });
    for (const r of RECEIVERS) {
      const c = await at(r.contract);
      expect(await c.getExpectedAuthor(), r.contract).to.equal(workflowOwner.address);
      expect(await c.getExpectedWorkflowName(), r.contract).to.equal(cre.workflowNameBytes10(r.name));
      expect(await c.getExpectedWorkflowId(), r.contract).to.equal(ids[r.contract]);
      expect(await c.getForwarderAddress(), r.contract).to.equal(await production.getAddress());
      expect(await c.simulationTransmitter(), r.contract).to.equal(ethers.ZeroAddress);
      const methods = lock.receivers[r.contract].txs.map((t) => t.method);
      expect(methods, r.contract).to.deep.equal([
        "setExpectedAuthor", "setExpectedWorkflowName", "setExpectedWorkflowId", "setForwarderAddress", "setSimulationTransmitter",
      ]);
    }

    // Behind the production forwarder any transmitting node may deliver, but only this workflow's reports land.
    const body = cre.encodeCollectionsReport([]);
    const collections = await at("CollectionsReceiver");
    const right = { workflowId: ids.CollectionsReceiver, name: cre.WORKFLOW_NAMES.COLLECTIONS };
    expect((await deliver(production, "CollectionsReceiver", body, right)).ok).to.equal(true);
    const wrongId = await deliver(production, "CollectionsReceiver", body, { ...right, workflowId: ids.GuardianReceiver });
    expect(collections.interface.parseError(wrongId.revert).name).to.equal("InvalidWorkflowId");
    const wrongOwner = await deliver(production, "CollectionsReceiver", body, { ...right, owner: stranger.address });
    expect(collections.interface.parseError(wrongOwner.revert).name).to.equal("InvalidAuthor");
    const oldForwarder = await ethers.getContractAt("MockKeystoneForwarder", record.contracts.MockKeystoneForwarder.address);
    expect(await oldForwarder.typeAndVersion()).to.match(/^MockKeystoneForwarder /);
    const viaOld = await deliver(oldForwarder, "CollectionsReceiver", body, { ...right, from: deployer });
    expect(collections.interface.parseError(viaOld.revert).name).to.equal("InvalidSender");

    // The record says what now holds.
    applyLock(record, lock);
    expect(record.cre.forwarderKind).to.equal("production");
    expect(record.cre.forwarder).to.equal(await production.getAddress());
    expect(record.cre.simulationTransmitter).to.equal(ethers.ZeroAddress);
    expect(record.cre.workflows.guardian.workflowId).to.equal(ids.GuardianReceiver);
    expect(record.cre.locked.receivers.UnderwritingReceiver.workflowId).to.equal(ids.UnderwritingReceiver);
  });

  it("is idempotent: a second run sends nothing", async () => {
    const opts = { workflowOwner: workflowOwner.address, workflowIds: ids, forwarderKind: "production", forwarderAddress: await production.getAddress() };
    await lockReceivers(hre, record, opts);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const again = await lockReceivers(hre, record, opts);
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    for (const r of Object.values(again.receivers)) expect(r.txs).to.deep.equal([]);
  });

  it("while still simulating, adds the identity checks and keeps the forwarder and the transmitter guard", async () => {
    await lockReceivers(hre, record, { workflowOwner: workflowOwner.address, workflowIds: { GuardianReceiver: ids.GuardianReceiver }, forwarderKind: "simulation" });
    const guardian = await at("GuardianReceiver");
    expect(await guardian.getExpectedWorkflowId()).to.equal(ids.GuardianReceiver);
    expect(await guardian.getForwarderAddress()).to.equal(record.contracts.MockKeystoneForwarder.address);
    expect(await guardian.simulationTransmitter()).to.equal(deployer.address);
    // A receiver without an id is left exactly as it was.
    expect(await (await at("CollectionsReceiver")).getExpectedAuthor()).to.equal(ethers.ZeroAddress);
  });

  it("refuses to start without an owner, with a malformed id, with no ids, or without a production forwarder", async () => {
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const base = { workflowOwner: workflowOwner.address, workflowIds: ids, forwarderKind: "production", forwarderAddress: await production.getAddress() };
    const bad = [
      [{ ...base, workflowOwner: ethers.ZeroAddress }, /workflowOwner/],
      [{ ...base, workflowIds: { ...ids, GuardianReceiver: "0x1234" } }, /bytes32/],
      [{ ...base, workflowIds: { ...ids, GuardianReceiver: ethers.ZeroHash } }, /non-zero/],
      [{ ...base, workflowIds: {} }, /nothing to lock/],
      [{ ...base, forwarderAddress: ethers.ZeroAddress }, /production forwarder/],
      [{ ...base, forwarderKind: "sideways" }, /forwarderKind/],
    ];
    for (const [opts, message] of bad) {
      let err;
      try {
        await lockReceivers(hre, record, opts);
      } catch (e) {
        err = e;
      }
      expect(err?.message, String(message)).to.match(message);
    }
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce, "nothing was sent");
  });

  // PoC F5 (security review): production mode took any forwarder, Chainlink's
  // public MockKeystoneForwarder included, then cleared the transmitter, and a
  // stranger could deliver a forged report with the locked identity through it.
  it("refuses a simulation forwarder as the production one, and sends nothing: the transmitter guard stays", async () => {
    const mock = await (await ethers.getContractFactory("MockKeystoneForwarder")).deploy();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    let err;
    try {
      await lockReceivers(hre, record, { workflowOwner: workflowOwner.address, workflowIds: ids, forwarderKind: "production", forwarderAddress: await mock.getAddress() });
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.match(/MockKeystoneForwarder/);
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce, "nothing was sent");
    const guardian = await at("GuardianReceiver");
    expect(await guardian.simulationTransmitter()).to.equal(deployer.address);

    // So the forged attestation of the PoC still does not land through the
    // public forwarder the receivers trust: a stranger is not the transmitter.
    const trusted = await ethers.getContractAt("MockKeystoneForwarder", record.contracts.MockKeystoneForwarder.address);
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const forged = cre.encodeGuardianReport(
      cre.buildAttestation({ price: 90_000_000n, priceRoundId: 1n, priceUpdatedAt: now, pool: await guardian.currentInputs().then(([s]) => s), observedAt: now })
    );
    const r = await deliver(trusted, "GuardianReceiver", forged, { workflowId: ids.GuardianReceiver, name: cre.WORKFLOW_NAMES.GUARDIAN });
    expect(r.ok).to.equal(false);
    expect(guardian.interface.parseError(r.revert).name).to.equal("NotSimulationTransmitter");
    expect((await guardian.creditStatus()).paused).to.equal(false);
  });

  it("refuses a production forwarder that is not a KeystoneForwarder, or that is not Chainlink's on public Monad testnet", async () => {
    const tv = (typeAndVersion, extra = {}) => productionForwarderProblem({ address: "0x00000000000000000000000000000000000000f1", typeAndVersion, chainId: 31337, local: true, ...extra });
    expect(tv("KeystoneForwarder 1.0.0")).to.equal(null);
    expect(tv("MockKeystoneForwarder 1.0.0")).to.match(/MockKeystoneForwarder: anyone can call it/);
    expect(tv(null)).to.match(/no typeAndVersion/);
    expect(tv("OCR2Aggregator 1.0.0")).to.match(/not a KeystoneForwarder/);
    expect(productionForwarderProblem({ address: MONAD_TESTNET.CRE_MOCK_FORWARDER, typeAndVersion: "KeystoneForwarder 1.0.0", chainId: 10143, local: false })).to.match(
      /Chainlink's MockKeystoneForwarder/
    );
    // On the public chain only Chainlink's own KeystoneForwarder address is taken; CRE_FORWARDER_ADDRESS is for local chains.
    expect(productionForwarderProblem({ address: "0x00000000000000000000000000000000000000f1", typeAndVersion: "KeystoneForwarder 1.0.0", chainId: 10143, local: false })).to.match(
      /only Chainlink's KeystoneForwarder/
    );
    expect(productionForwarderProblem({ address: MONAD_TESTNET.CRE_KEYSTONE_FORWARDER, typeAndVersion: "KeystoneForwarder 1.0.0", chainId: 10143, local: false })).to.equal(null);
  });

  it("knows a local chain from Monad testnet: the in-process network and 127.0.0.1 nodes, never testnet-rpc", () => {
    expect(isLocalNetwork(hre)).to.equal(true);
    expect(isLocalNetwork({ network: { name: "monadLocal", config: { url: "http://127.0.0.1:8600" } } })).to.equal(true);
    expect(isLocalNetwork({ network: { name: "monadTestnet", config: { url: "https://testnet-rpc.monad.xyz" } } })).to.equal(false);
    expect(isLocalNetwork({ network: { name: "somewhere", config: { url: "https://rpc.example" } } })).to.equal(false);
  });
});
