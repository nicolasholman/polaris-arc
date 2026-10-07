/**
 * The Chainlink CRE receivers: CollectionsReceiver (the `polaris-collections`
 * cron workflow) and UnderwritingReceiver (the `polaris-underwrite` HTTP
 * workflow). GuardianReceiver has its own suite (Guardian.test.js). Reports arrive through a MockKeystoneForwarder with the same raw
 * layout as Chainlink's forwarders: a 109-byte header (workflow id, name,
 * owner, report id) and the body. Tests are named for what each refuses.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");

const { signTyped, signPermit } = require("../helpers/sign");
const { scoreFromFacts } = require("../helpers/underwrite-mirror");
const { TYPES } = require("../../lib/eip712");
const cre = require("../../lib/cre");

const AUSD = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const GRACE = DAY;

const coder = ethers.AbiCoder.defaultAbiCoder();

async function deployStack() {
  const [owner, relayer, merchant, treasury, stranger, don, workflowOwner] = await ethers.getSigners();
  const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, ausd, scores, treasury.address, GRACE, 60);
  const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, ausd, treasury.address, 60);
  const checkout = await (await ethers.getContractFactory("PolarisCheckout")).deploy(owner.address, engine, payments, scores);
  const forwarder = await (await ethers.getContractFactory("MockKeystoneForwarder")).deploy();
  const collections = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(forwarder, engine, payments, don.address);
  const underwriting = await (await ethers.getContractFactory("UnderwritingReceiver")).deploy(forwarder, scores, don.address);

  await scores.setWriter(engine, true);
  await scores.setUnderwriter(underwriting, true);
  await engine.setOriginator(checkout, true);
  await payments.setCheckout(checkout);
  await ausd.mint(owner.address, AUSD(100_000));
  await ausd.approve(engine, AUSD(100_000));
  await engine.fund(AUSD(50_000));

  return { ausd, scores, engine, payments, checkout, forwarder, collections, underwriting, owner, relayer, merchant, treasury, stranger, don, workflowOwner };
}

describe("Chainlink CRE receivers", () => {
  let s;

  beforeEach(async () => {
    s = await loadFixture(deployStack);
  });

  const now = async () => BigInt(await time.latest());
  const decodeError = (contract, data) => contract.interface.parseError(data);

  /** Deliver `body` to `receiver` through `forwarder` the way a DON does. */
  async function deliver(receiver, body, { from = s.don, forwarder = s.forwarder, workflowName = "", workflowOwner, workflowId, gasLimit } = {}) {
    const raw = cre.encodeRawReport({
      body,
      workflowName,
      workflowOwner: workflowOwner ?? s.workflowOwner.address,
      workflowId: workflowId ?? ethers.ZeroHash,
      executionId: ethers.hexlify(ethers.randomBytes(32)),
      timestamp: Number(await now()),
    });
    const tx = await forwarder.connect(from).report(await receiver.getAddress(), raw, "0x", [], gasLimit ? { gasLimit } : {});
    const receipt = await tx.wait();
    const processed = receipt.logs
      .map((l) => { try { return forwarder.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ReportProcessed");
    return { receipt, tx, ok: processed.args.result, revert: await forwarder.lastRevertData() };
  }

  /** A gasless buyer with an open Pay in 4 plan through the checkout. */
  async function buyerWithPlan(principal = AUSD(200), interval = WEEK) {
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    await s.ausd.mint(buyer.address, AUSD(1_000));
    const intent = {
      buyer: buyer.address,
      merchant: s.merchant.address,
      principal,
      installments: 4,
      interval: BigInt(interval),
      orderId: `o-${Math.random()}`,
      nonce: 0n,
      deadline: (await now()) + 600n,
    };
    const q = await s.checkout.quotePlan(buyer.address, principal, 4, interval);
    const p = await signPermit(s.ausd, buyer, await s.engine.getAddress(), q.permitValue);
    const sig = (await signTyped(buyer, s.checkout, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent)).signature;
    await s.checkout.connect(s.relayer).openPlan(intent, sig, { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s });
    return { buyer, loanId: await s.engine.loanCount() };
  }

  function facts(overrides = {}) {
    return {
      walletAgeDays: 730,
      txCount: 1_200,
      stableBalance: AUSD(2_500),
      defiTenureDays: 400,
      priorLiquidations: 0,
      relatedWallets: 1,
      exchangeFunded: true,
      observedAt: 0n,
      ...overrides,
    };
  }

  const collect = (id) => ({ action: cre.ACTION.COLLECT_INSTALLMENT, id });

  // ---------------------------------------------------------------------
  describe("the ReceiverTemplate checks", () => {
    it("only the configured forwarder can deliver a report", async () => {
      const body = cre.encodeCollectionsReport([]);
      const meta = "0x" + "00".repeat(64);
      for (const r of [s.collections, s.underwriting]) {
        await expect(r.connect(s.stranger).onReport(meta, body))
          .to.be.revertedWithCustomError(r, "InvalidSender")
          .withArgs(s.stranger.address, await s.forwarder.getAddress());
      }
    });

    it("a forged report delivered through any other forwarder is refused", async () => {
      const rogue = await (await ethers.getContractFactory("MockKeystoneForwarder")).deploy();
      const t = await now();
      const r = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: s.stranger.address, facts: facts({ observedAt: t }) }]), { forwarder: rogue });
      expect(r.ok).to.equal(false);
      expect(decodeError(s.underwriting, r.revert).name).to.equal("InvalidSender");
      expect((await s.scores.profileOf(s.stranger.address)).underwritten).to.equal(false);
    });

    it("with the workflow owner and name set, a report from another owner or another workflow is refused", async () => {
      await s.underwriting.setExpectedAuthor(s.workflowOwner.address);
      await s.underwriting.setExpectedWorkflowName(cre.WORKFLOW_NAMES.UNDERWRITING);
      const user = ethers.Wallet.createRandom().address;
      const body = cre.encodeUnderwritingReport([{ user, facts: facts({ observedAt: await now() }) }]);

      const wrongOwner = await deliver(s.underwriting, body, { workflowName: cre.WORKFLOW_NAMES.UNDERWRITING, workflowOwner: s.stranger.address });
      expect(decodeError(s.underwriting, wrongOwner.revert).name).to.equal("InvalidAuthor");
      const wrongName = await deliver(s.underwriting, body, { workflowName: cre.WORKFLOW_NAMES.COLLECTIONS });
      expect(decodeError(s.underwriting, wrongName.revert).name).to.equal("InvalidWorkflowName");
      expect((await s.scores.profileOf(user)).underwritten).to.equal(false);

      const right = await deliver(s.underwriting, body, { workflowName: cre.WORKFLOW_NAMES.UNDERWRITING });
      expect(right.ok).to.equal(true);
      expect((await s.scores.profileOf(user)).underwritten).to.equal(true);
    });

    it("with a workflow id pinned, a report from any other build of the workflow is refused", async () => {
      const id = ethers.id("polaris-collections build 1");
      await s.collections.setExpectedWorkflowId(id);
      const body = cre.encodeCollectionsReport([]);
      expect(decodeError(s.collections, (await deliver(s.collections, body, { workflowId: ethers.id("build 2") })).revert).name).to.equal("InvalidWorkflowId");
      expect((await deliver(s.collections, body, { workflowId: id })).ok).to.equal(true);
    });

    it("encodes workflow names as the forwarder does (sha256, 10 hex chars, as ASCII)", async () => {
      expect(cre.workflowNameBytes10("my_workflow")).to.equal("0x62373666336165316465"); // the CRE docs' example
      expect(cre.workflowNameBytes10(cre.WORKFLOW_NAMES.COLLECTIONS)).to.equal("0x38323961376630323863");
      expect(cre.workflowNameBytes10(cre.WORKFLOW_NAMES.UNDERWRITING)).to.equal("0x39333731613831386437");
      await s.collections.setExpectedWorkflowName(cre.WORKFLOW_NAMES.COLLECTIONS);
      expect(await s.collections.getExpectedWorkflowName()).to.equal(cre.workflowNameBytes10(cre.WORKFLOW_NAMES.COLLECTIONS));
    });

    it("declares IReceiver through ERC-165, which the forwarders check before delivering", async () => {
      const onReport = s.collections.interface.getFunction("onReport").selector;
      const erc165 = s.collections.interface.getFunction("supportsInterface").selector;
      for (const r of [s.collections, s.underwriting]) {
        expect(await r.supportsInterface(onReport)).to.equal(true);
        expect(await r.supportsInterface(erc165)).to.equal(true);
        expect(await r.supportsInterface("0xdeadbeef")).to.equal(false);
      }
      // A contract that is not a receiver gets nothing delivered.
      const r = await deliver(s.engine, "0x");
      expect(r.ok).to.equal(false);
    });

    it("only the owner reconfigures a receiver", async () => {
      for (const r of [s.collections, s.underwriting]) {
        await expect(r.connect(s.stranger).setForwarderAddress(s.stranger.address)).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
        await expect(r.connect(s.stranger).setExpectedAuthor(s.stranger.address)).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
        await expect(r.connect(s.stranger).setExpectedWorkflowName("x")).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
        await expect(r.connect(s.stranger).setExpectedWorkflowId(ethers.ZeroHash)).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
      }
      for (const r of [s.collections, s.underwriting]) {
        await expect(r.connect(s.stranger).setSimulationTransmitter(s.stranger.address)).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
      }
    });

    it("refuses a report of another receiver's kind, naming the kind, even one that would not decode", async () => {
      const r1 = await deliver(s.collections, cre.encodeUnderwritingReport([]));
      expect(decodeError(s.collections, r1.revert)?.args[0]).to.equal(2n);
      const r2 = await deliver(s.underwriting, cre.encodeCollectionsReport([]));
      expect(decodeError(s.underwriting, r2.revert)?.name).to.equal("UnknownReportKind");
      const guardianBody = cre.encodeGuardianReport(cre.buildAttestation({ price: 1e8, priceUpdatedAt: 1, pool: {}, observedAt: 1 }));
      for (const r of [s.collections, s.underwriting]) {
        const res = await deliver(r, guardianBody);
        expect(decodeError(r, res.revert)?.name).to.equal("UnknownReportKind");
        expect(decodeError(r, res.revert)?.args[0]).to.equal(3n);
        expect(decodeError(r, (await deliver(r, "0x")).revert)?.args[0]).to.equal(0n);
      }
    });
  });

  // ---------------------------------------------------------------------
  describe("CollectionsReceiver", () => {
    it("collects every instalment that fell due in one report; the DON is just another caller", async () => {
      const a = await buyerWithPlan();
      const b = await buyerWithPlan(AUSD(100));
      await time.increase(WEEK);
      const dueA = await s.engine.installmentAmount(a.loanId);
      const dueB = await s.engine.installmentAmount(b.loanId);

      const { tx, ok } = await deliver(s.collections, cre.encodeCollectionsReport([collect(a.loanId), collect(b.loanId)]));
      expect(ok).to.equal(true);
      await expect(tx)
        .to.emit(s.collections, "TaskExecuted").withArgs(1, a.loanId, dueA)
        .and.to.emit(s.collections, "TaskExecuted").withArgs(1, b.loanId, dueB)
        .and.to.emit(s.collections, "CollectionsRun").withArgs(2, 2, 0)
        .and.to.emit(s.engine, "InstallmentCollected").withArgs(a.loanId, await s.collections.getAddress(), dueA);
      expect((await s.engine.getLoan(a.loanId)).installmentsPaid).to.equal(1);
      expect((await s.engine.getLoan(b.loanId)).installmentsPaid).to.equal(1);
    });

    it("while on the simulation forwarder, only the simulator's transmitter writes the collections record", async () => {
      const a = await buyerWithPlan();
      await time.increase(WEEK);
      const r = await deliver(s.collections, cre.encodeCollectionsReport([collect(a.loanId)]), { from: s.stranger });
      expect(r.ok).to.equal(false);
      const err = s.collections.interface.parseError(r.revert);
      expect([err.name, err.args[0]]).to.deep.equal(["NotSimulationTransmitter", s.stranger.address]);
      expect((await s.engine.getLoan(a.loanId)).installmentsPaid).to.equal(0);
      // Collecting stays permissionless on the engine itself: nothing here is the only way to collect.
      await expect(s.engine.connect(s.stranger).collectInstallment(a.loanId)).to.emit(s.engine, "InstallmentCollected");
    });

    it("a stranger cannot collect more than is due, even by listing a plan twice", async () => {
      await s.collections.setSimulationTransmitter(ethers.ZeroAddress); // as behind the production forwarder
      const a = await buyerWithPlan();
      await time.increase(WEEK);
      const due = await s.engine.installmentAmount(a.loanId);
      const before = await s.ausd.balanceOf(a.buyer.address);
      const { tx } = await deliver(s.collections, cre.encodeCollectionsReport([collect(a.loanId), collect(a.loanId)]), { from: s.stranger });
      await expect(tx).to.emit(s.collections, "CollectionsRun").withArgs(2, 1, 1);
      await expect(tx)
        .to.emit(s.collections, "TaskSkipped")
        .withArgs(1, a.loanId, s.engine.interface.getError("NotDue").selector);
      expect(await s.ausd.balanceOf(a.buyer.address)).to.equal(before - due);
    });

    it("skips each failing plan with the engine's own reason, so the dunning ladder can tell them apart, and runs the rest", async () => {
      const good = await buyerWithPlan();
      const revoked = await buyerWithPlan();
      const broke = await buyerWithPlan();
      const early = await buyerWithPlan(AUSD(100), 2 * WEEK);
      await time.increase(WEEK);

      // One buyer withdraws the allowance, another spends the balance. Both hold no gas,
      // so their token calls are relayed signatures in the app; here we impersonate.
      for (const [w, fn] of [
        [revoked.buyer, (t) => t.approve(s.engine, 0)],
        [broke.buyer, async (t) => t.transfer(s.stranger.address, await s.ausd.balanceOf(broke.buyer.address))],
      ]) {
        await impersonateAccount(w.address);
        await setBalance(w.address, ethers.parseEther("1"));
        await fn(s.ausd.connect(await ethers.getSigner(w.address)));
        await setBalance(w.address, 0n);
      }

      const tasks = [collect(good.loanId), collect(revoked.loanId), collect(broke.loanId), collect(early.loanId), collect(999n)];
      const { receipt } = await deliver(s.collections, cre.encodeCollectionsReport(tasks));
      const skipped = receipt.logs
        .map((l) => { try { return s.collections.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "TaskSkipped")
        .map((e) => [e.args.id, s.engine.interface.parseError(e.args.reason)]);

      const due = await s.engine.installmentAmount(revoked.loanId);
      expect(skipped.map(([id, err]) => [id, err.name])).to.deep.equal([
        [revoked.loanId, "InsufficientAllowance"],
        [broke.loanId, "InsufficientBalance"],
        [early.loanId, "NotDue"],
        [999n, "InvalidLoan"],
      ]);
      expect(skipped[0][1].args).to.deep.equal([0n, due]); // have, need: "sign again"
      expect(skipped[1][1].args).to.deep.equal([0n, due]); // have, need: "top up"
      expect((await s.engine.getLoan(good.loanId)).installmentsPaid).to.equal(1);
    });

    it("charges subscriptions that renewed and liquidates plans past grace", async () => {
      // A subscription through the checkout.
      const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
      await s.ausd.mint(buyer.address, AUSD(100));
      await s.payments.connect(s.merchant).createPlan(AUSD(10), MONTH, "Pro");
      const intent = {
        buyer: buyer.address, merchant: s.merchant.address, planId: 1n, pricePerPeriod: AUSD(10),
        periodSeconds: BigInt(MONTH), orderId: "sub", nonce: 0n, deadline: (await now()) + 600n,
      };
      const p = await signPermit(s.ausd, buyer, await s.payments.getAddress(), AUSD(120));
      await s.checkout.connect(s.relayer).subscribe(
        intent,
        (await signTyped(buyer, s.checkout, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent)).signature,
        { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s }
      );
      // A plan whose buyer vanished.
      const gone = await buyerWithPlan();
      await impersonateAccount(gone.buyer.address);
      await setBalance(gone.buyer.address, ethers.parseEther("1"));
      await s.ausd.connect(await ethers.getSigner(gone.buyer.address)).approve(s.engine, 0);

      await time.increase(MONTH);
      const tasks = [
        { action: cre.ACTION.CHARGE_SUBSCRIPTION, id: 1n },
        { action: cre.ACTION.LIQUIDATE, id: gone.loanId },
      ];
      expect(await s.collections.checkTasks(tasks)).to.deep.equal([true, true]);
      const { tx } = await deliver(s.collections, cre.encodeCollectionsReport(tasks));
      await expect(tx)
        .to.emit(s.payments, "SubscriptionCharged").withArgs(1n, AUSD(10), AUSD(0.05), 2)
        .and.to.emit(s.engine, "LoanLiquidated")
        .and.to.emit(s.collections, "CollectionsRun").withArgs(2, 2, 0);
      expect((await s.engine.getLoan(gone.loanId)).status).to.equal(2n); // Liquidated
    });

    it("checkTasks tells the workflow which candidates are actionable, in one read", async () => {
      const a = await buyerWithPlan();
      const tasks = [
        collect(a.loanId),
        { action: cre.ACTION.LIQUIDATE, id: a.loanId },
        { action: cre.ACTION.CHARGE_SUBSCRIPTION, id: 7n },
        { action: 9, id: a.loanId },
      ];
      expect(await s.collections.checkTasks(tasks)).to.deep.equal([false, false, false, false]);
      await time.increase(WEEK);
      expect(await s.collections.checkTasks(tasks)).to.deep.equal([true, false, false, false]);
      await time.increase(GRACE + 1);
      expect(await s.collections.checkTasks(tasks)).to.deep.equal([true, true, false, false]);
    });

    it("a subscription id that was never created is never due, and charging it is refused, not a panic", async () => {
      expect(await s.payments.isChargeDue(7n)).to.equal(false);
      await expect(s.payments.chargeDue(7n)).to.be.revertedWithCustomError(s.payments, "SubscriptionNotActive");
      const { tx } = await deliver(s.collections, cre.encodeCollectionsReport([{ action: cre.ACTION.CHARGE_SUBSCRIPTION, id: 7n }]));
      await expect(tx)
        .to.emit(s.collections, "TaskSkipped")
        .withArgs(2, 7n, s.payments.interface.getError("SubscriptionNotActive").selector);
    });

    it("skips an unknown action without touching anything", async () => {
      const { tx } = await deliver(s.collections, cre.encodeCollectionsReport([{ action: 9, id: 1n }]));
      await expect(tx)
        .to.emit(s.collections, "TaskSkipped")
        .withArgs(9, 1n, s.collections.interface.encodeErrorResult("UnknownAction", [9]));
    });

    it("a report that runs out of gas is refused whole, so the forwarder can retry it, instead of skipping the buyer", async () => {
      const guzzler = await (await ethers.getContractFactory("GasGuzzler")).deploy();
      const receiver = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(s.forwarder, guzzler, guzzler, s.don.address);
      const r = await deliver(receiver, cre.encodeCollectionsReport([collect(1n)]), { gasLimit: 3_000_000 });
      expect(r.ok).to.equal(false);
      const err = receiver.interface.parseError(r.revert);
      expect(err.name).to.equal("InsufficientGasForTask");
      expect(err.args[0]).to.equal(0n);
    });

    it("refuses construction without an engine or payments", async () => {
      const F = await ethers.getContractFactory("CollectionsReceiver");
      await expect(F.deploy(s.forwarder, ethers.ZeroAddress, s.payments, s.don.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(ethers.ZeroAddress, s.engine, s.payments, s.don.address)).to.be.revertedWithCustomError(F, "InvalidForwarderAddress");
    });
  });

  // ---------------------------------------------------------------------
  describe("UnderwritingReceiver", () => {
    beforeEach(async () => {
      await s.scores.setRequireUnderwriting(true);
    });

    it("a DON report of facts opens the first line; the score is computed on chain, never reported", async () => {
      const user = ethers.Wallet.createRandom().address;
      const history = ethers.Wallet.createRandom().address;
      const f = facts({ observedAt: await now() });
      expect(await s.scores.creditLimitOf(user)).to.equal(0n, "no report, no unsecured line");

      const expected = scoreFromFacts(f).score;
      const { tx, ok } = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user, linkedWallet: history, facts: f }]));
      expect(ok).to.equal(true);
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingApplied").withArgs(user, history, expected)
        .and.to.emit(s.scores, "Underwritten").withArgs(user, expected, false, f.observedAt);
      expect(expected).to.equal(664);
      expect(await s.scores.creditLimitOf(user)).to.equal(AUSD(500));
      expect(await s.underwriting.linkedUserOf(history)).to.equal(user);
    });

    it("a stale underwriting report is refused", async () => {
      const user = ethers.Wallet.createRandom().address;
      const f = facts({ observedAt: (await now()) - 16n * 60n });
      const { tx } = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user, facts: f }]));
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingRefused")
        .withArgs(user, ethers.ZeroAddress, s.scores.interface.getError("StaleEvidence").selector);
      expect(await s.scores.creditLimitOf(user)).to.equal(0n);
    });

    it("a report about accounts with no history opens no line, however many of them one person makes", async () => {
      // The reproduced sybil farm: fresh accounts, each reported with facts
      // that are all zero, each opened a $200 unsecured line.
      const empty = { walletAgeDays: 0, txCount: 0, stableBalance: 0n, defiTenureDays: 0, priorLiquidations: 0, relatedWallets: 0, exchangeFunded: false };
      const t = await now();
      const accounts = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom().address);
      const freshWallet = ethers.Wallet.createRandom().address;
      const items = accounts.map((user, i) => ({ user, linkedWallet: i === 0 ? freshWallet : ethers.ZeroAddress, facts: { ...empty, observedAt: t } }));
      const { tx, ok } = await deliver(s.underwriting, cre.encodeUnderwritingReport(items));
      expect(ok).to.equal(true);
      const thin = s.scores.interface.encodeErrorResult("ThinFile", [0, 0]);
      for (const { user, linkedWallet } of items) {
        await expect(tx).to.emit(s.underwriting, "UnderwritingRefused").withArgs(user, linkedWallet, thin);
        expect(await s.scores.creditLimitOf(user)).to.equal(0n);
        expect((await s.scores.profileOf(user)).underwritten).to.equal(false);
      }
      await expect(tx).to.not.emit(s.underwriting, "UnderwritingApplied");
      // Linking a wallet as young as the account lends it nothing, and links nothing.
      expect(await s.underwriting.linkedUserOf(freshWallet)).to.equal(ethers.ZeroAddress);

      // The same account, later, with a real history wallet: the line opens.
      const history = ethers.Wallet.createRandom().address;
      await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: accounts[0], linkedWallet: history, facts: facts({ observedAt: await now() }) }]));
      expect(await s.scores.creditLimitOf(accounts[0])).to.equal(AUSD(500));
    });

    it("a second underwrite cannot reset a record", async () => {
      const user = ethers.Wallet.createRandom().address;
      await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user, facts: facts({ observedAt: await now(), relatedWallets: 20 }) }]));
      const low = await s.scores.scoreOf(user);
      const { tx } = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user, facts: facts({ observedAt: await now() }) }]));
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingRefused")
        .withArgs(user, ethers.ZeroAddress, s.scores.interface.getError("AlreadyHasRecord").selector);
      expect(await s.scores.scoreOf(user)).to.equal(low);
    });

    it("one history wallet backs one account: an old wallet cannot open a line for every new account", async () => {
      const [a, b, c] = [0, 1, 2].map(() => ethers.Wallet.createRandom().address);
      const history = ethers.Wallet.createRandom().address;
      await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: a, linkedWallet: history, facts: facts({ observedAt: await now() }) }]));

      const { tx } = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: b, linkedWallet: history, facts: facts({ observedAt: await now() }) }]));
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingRefused")
        .withArgs(b, history, s.underwriting.interface.encodeErrorResult("WalletAlreadyLinked", [history, a]));
      expect(await s.scores.creditLimitOf(b)).to.equal(0n);

      // A refused report links nothing.
      const other = ethers.Wallet.createRandom().address;
      await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: c, linkedWallet: other, facts: facts({ observedAt: 1n }) }]));
      expect(await s.underwriting.linkedUserOf(other)).to.equal(ethers.ZeroAddress);
    });

    it("one history opens one line: a wallet backing an account cannot then be underwritten as an account itself", async () => {
      const account = ethers.Wallet.createRandom().address;
      const history = ethers.Wallet.createRandom().address;
      await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: account, linkedWallet: history, facts: facts({ observedAt: await now() }) }]));
      expect(await s.scores.creditLimitOf(account)).to.equal(AUSD(500));

      // The history wallet asks for a line of its own, alone or linking yet another wallet.
      for (const linkedWallet of [ethers.ZeroAddress, ethers.Wallet.createRandom().address]) {
        const { tx } = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: history, linkedWallet, facts: facts({ observedAt: await now() }) }]));
        await expect(tx)
          .to.emit(s.underwriting, "UnderwritingRefused")
          .withArgs(history, linkedWallet, s.underwriting.interface.encodeErrorResult("UserIsLinkedHistory", [history, account]));
      }
      expect(await s.scores.creditLimitOf(history)).to.equal(0n);
      expect((await s.scores.profileOf(history)).underwritten).to.equal(false);
    });

    it("one history opens one line: an account already underwritten cannot be linked as another account's history", async () => {
      const first = ethers.Wallet.createRandom().address;
      const second = ethers.Wallet.createRandom().address;
      await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: first, facts: facts({ observedAt: await now() }) }]));
      expect((await s.scores.profileOf(first)).underwritten).to.equal(true);

      const { tx } = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: second, linkedWallet: first, facts: facts({ observedAt: await now() }) }]));
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingRefused")
        .withArgs(second, first, s.underwriting.interface.encodeErrorResult("WalletAlreadyUnderwritten", [first]));
      expect(await s.scores.creditLimitOf(second)).to.equal(0n);
      expect(await s.underwriting.linkedUserOf(first)).to.equal(ethers.ZeroAddress, "a refused link records nothing");
    });

    it("one history opens one line within a single batch too, in either order", async () => {
      const [x, y, p, q] = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom().address);
      const t = await now();
      const { tx } = await deliver(
        s.underwriting,
        cre.encodeUnderwritingReport([
          { user: x, facts: facts({ observedAt: t }) },
          { user: y, linkedWallet: x, facts: facts({ observedAt: t }) }, // x already has its own line
          { user: p, linkedWallet: q, facts: facts({ observedAt: t }) },
          { user: q, facts: facts({ observedAt: t }) }, // q already backs p
        ])
      );
      await expect(tx).to.emit(s.underwriting, "UnderwritingApplied").withArgs(x, ethers.ZeroAddress, 664);
      await expect(tx).to.emit(s.underwriting, "UnderwritingApplied").withArgs(p, q, 664);
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingRefused")
        .withArgs(y, x, s.underwriting.interface.encodeErrorResult("WalletAlreadyUnderwritten", [x]));
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingRefused")
        .withArgs(q, ethers.ZeroAddress, s.underwriting.interface.encodeErrorResult("UserIsLinkedHistory", [q, p]));
      expect(await s.scores.creditLimitOf(y)).to.equal(0n);
      expect(await s.scores.creditLimitOf(q)).to.equal(0n);
    });

    it("applies each buyer in a batch independently", async () => {
      const [good, stale] = [0, 1].map(() => ethers.Wallet.createRandom().address);
      const t = await now();
      const { tx } = await deliver(
        s.underwriting,
        cre.encodeUnderwritingReport([
          { user: good, facts: facts({ observedAt: t }) },
          { user: stale, facts: facts({ observedAt: t - 3600n }) },
          { user: ethers.ZeroAddress, facts: facts({ observedAt: t }) },
        ])
      );
      await expect(tx).to.emit(s.underwriting, "UnderwritingApplied").withArgs(good, ethers.ZeroAddress, 664);
      await expect(tx).to.emit(s.underwriting, "UnderwritingRefused").withArgs(stale, ethers.ZeroAddress, s.scores.interface.getError("StaleEvidence").selector);
      await expect(tx)
        .to.emit(s.underwriting, "UnderwritingRefused")
        .withArgs(ethers.ZeroAddress, ethers.ZeroAddress, s.underwriting.interface.encodeErrorResult("InvalidUser", [ethers.ZeroAddress]));
    });

    it("while on the simulation forwarder, a stranger calling it cannot write credit facts", async () => {
      const user = s.stranger.address;
      const body = cre.encodeUnderwritingReport([{ user, facts: facts({ observedAt: await now(), walletAgeDays: 3650 }) }]);
      const r = await deliver(s.underwriting, body, { from: s.stranger });
      expect(r.ok).to.equal(false);
      const err = s.underwriting.interface.parseError(r.revert);
      expect(err.name).to.equal("NotSimulationTransmitter");
      expect(err.args[0]).to.equal(s.stranger.address);
      expect(await s.scores.creditLimitOf(user)).to.equal(0n);

      // Nor by calling route() on the forwarder directly.
      await s.forwarder.connect(s.stranger).route(await s.underwriting.getAddress(), "0x" + "00".repeat(64), body);
      expect(await s.scores.creditLimitOf(user)).to.equal(0n);

      // The simulator's own key can.
      expect((await deliver(s.underwriting, body)).ok).to.equal(true);
    });

    it("clearing the transmitter guard is for the production forwarder, whose DON signatures replace it", async () => {
      await expect(s.underwriting.setSimulationTransmitter(ethers.ZeroAddress))
        .to.emit(s.underwriting, "SimulationTransmitterSet").withArgs(ethers.ZeroAddress);
      const user = ethers.Wallet.createRandom().address;
      const r = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user, facts: facts({ observedAt: await now() }) }]), { from: s.relayer });
      expect(r.ok).to.equal(true);
    });

    it("with the forwarder check switched off, every report is refused rather than every caller accepted", async () => {
      await s.underwriting.setForwarderAddress(ethers.ZeroAddress);
      await s.underwriting.setSimulationTransmitter(ethers.ZeroAddress);
      const body = cre.encodeUnderwritingReport([{ user: s.stranger.address, facts: facts({ observedAt: await now() }) }]);
      await expect(s.underwriting.connect(s.stranger).onReport("0x" + "00".repeat(64), body)).to.be.revertedWithCustomError(
        s.underwriting,
        "ForwarderCheckDisabled"
      );
    });

    it("the receiver is the only underwriter: the relayer, the owner and the collections receiver are refused", async () => {
      const f = facts({ observedAt: await now() });
      for (const who of [s.relayer, s.owner]) {
        await expect(s.scores.connect(who).underwrite(who.address, f)).to.be.revertedWithCustomError(s.scores, "NotUnderwriter");
      }
      expect(await s.scores.isUnderwriter(await s.collections.getAddress())).to.equal(false);
    });

    it("a report that runs out of gas is refused whole", async () => {
      const guzzler = await (await ethers.getContractFactory("GasGuzzler")).deploy();
      const receiver = await (await ethers.getContractFactory("UnderwritingReceiver")).deploy(s.forwarder, guzzler, s.don.address);
      const r = await deliver(receiver, cre.encodeUnderwritingReport([{ user: s.stranger.address, facts: facts() }]), { gasLimit: 3_000_000 });
      expect(r.ok).to.equal(false);
      expect(receiver.interface.parseError(r.revert).name).to.equal("InsufficientGasForItem");
    });

    it("decodes exactly the report the workflow encodes", async () => {
      const f = facts({ observedAt: 123n });
      const body = cre.encodeUnderwritingReport([{ user: s.stranger.address, facts: f }]);
      const [kind, items] = coder.decode(["uint8", cre.UNDERWRITINGS_TYPE], body);
      expect(kind).to.equal(2n);
      expect(items[0].user).to.equal(s.stranger.address);
      expect(items[0].facts.stableBalance).to.equal(f.stableBalance);
      expect(items[0].facts.observedAt).to.equal(123n);
    });
  });
  // ---------------------------------------------------------------------
  describe("lib/cre.js: one report format per workflow, encoded and decoded", () => {
    it("round-trips a collections report, including the instant retry's", () => {
      const tasks = [collect(7n), { action: cre.ACTION.CHARGE_SUBSCRIPTION, id: 2n }, { action: cre.ACTION.LIQUIDATE, id: 2n ** 200n }];
      const body = cre.encodeCollectionsReport(tasks);
      expect(cre.reportKind(body)).to.equal(cre.REPORT_KIND.COLLECTIONS);
      expect(cre.decodeCollectionsReport(body)).to.deep.equal({ kind: 1, tasks });
      expect(cre.decodeCollectionsReport(cre.encodeCollectionsReport([]))).to.deep.equal({ kind: 1, tasks: [] });
    });

    it("round-trips an underwriting report", () => {
      const f = { ...facts({ observedAt: 99n }), stableBalance: AUSD(12) };
      const items = [{ user: s.stranger.address, linkedWallet: s.don.address, facts: f }];
      const decoded = cre.decodeUnderwritingReport(cre.encodeUnderwritingReport(items));
      expect(decoded.kind).to.equal(2);
      expect(decoded.items[0].user).to.equal(s.stranger.address);
      expect(decoded.items[0].linkedWallet).to.equal(s.don.address);
      expect(decoded.items[0].facts).to.deep.equal(f);
    });

    it("round-trips a guardian attestation, negative prices and all", () => {
      const a = {
        priceRoundId: 18446744073709562345n,
        price: -1n,
        priceUpdatedAt: 1_700_000_000n,
        freeCash: AUSD(49_990),
        totalOwed: AUSD(201.53),
        badDebt: 0n,
        totalOriginated: AUSD(403.06),
        observedAt: 1_700_000_100n,
        creditPaused: true,
        reasons: cre.GUARDIAN_REASON.DEPEG,
      };
      const body = cre.encodeGuardianReport(a);
      expect(cre.reportKind(body)).to.equal(cre.REPORT_KIND.GUARDIAN);
      expect(cre.decodeGuardianReport(body)).to.deep.equal({ kind: 3, attestation: a });
      // A static tuple: the kind and ten words, no offsets.
      expect(ethers.dataLength(body)).to.equal(11 * 32);
    });

    it("names every workflow as the forwarder carries it", () => {
      expect(cre.workflowNameBytes10(cre.WORKFLOW_NAMES.GUARDIAN)).to.match(/^0x[0-9a-f]{20}$/);
      expect(Object.values(cre.WORKFLOW_NAMES)).to.deep.equal(["polaris-collections", "polaris-underwrite", "polaris-guardian"]);
    });
  });
});
