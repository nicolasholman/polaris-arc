/**
 * The keeper receivers: CollectionsReceiver (the keeper's collections run)
 * and UnderwritingReceiver (its credit reviews). Reports arrive as
 * `submitReport(body)` from the keeper's own key, which pays gas in USDC on
 * Arc. Tests are named for what each refuses.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");

const { signTyped, signPermit } = require("../helpers/sign");
const { scoreFromFacts } = require("../helpers/underwrite-mirror");
const { TYPES } = require("../../lib/eip712");
const cre = require("../../lib/keeper");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const GRACE = DAY;

const coder = ethers.AbiCoder.defaultAbiCoder();

async function deployStack() {
  const [owner, relayer, merchant, treasury, stranger, keeper] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy("USDC");
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, usdc, scores, treasury.address, GRACE, 60);
  const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, usdc, treasury.address, 60);
  const checkout = await (await ethers.getContractFactory("PolarisCheckout")).deploy(owner.address, engine, payments, scores);
  const collections = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(keeper.address, engine, payments);
  const underwriting = await (await ethers.getContractFactory("UnderwritingReceiver")).deploy(keeper.address, scores);

  await scores.setWriter(engine, true);
  await scores.setUnderwriter(underwriting, true);
  await engine.setOriginator(checkout, true);
  await payments.setCheckout(checkout);
  await usdc.mint(owner.address, USDC(100_000));
  await usdc.approve(engine, USDC(100_000));
  await engine.fund(USDC(50_000));

  return { usdc, scores, engine, payments, checkout, collections, underwriting, owner, relayer, merchant, treasury, stranger, keeper };
}

describe("Keeper receivers", () => {
  let s;

  beforeEach(async () => {
    s = await loadFixture(deployStack);
  });

  const now = async () => BigInt(await time.latest());
  const decodeError = (contract, data) => contract.interface.parseError(data);

  /**
   * Submit `body` to `receiver` as the keeper does. A revert is returned, not
   * thrown: { ok: false, revert: <revert data> }.
   */
  async function deliver(receiver, body, { from = s.keeper, gasLimit } = {}) {
    try {
      const tx = await receiver.connect(from).submitReport(body, gasLimit ? { gasLimit } : {});
      const receipt = await tx.wait();
      return { receipt, tx, ok: true, revert: "0x" };
    } catch (e) {
      const data = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
      if (typeof data !== "string") throw e;
      return { receipt: null, tx: null, ok: false, revert: data };
    }
  }

  /** A gasless buyer with an open Pay in 4 plan through the checkout. */
  async function buyerWithPlan(principal = USDC(200), interval = WEEK) {
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    await s.usdc.mint(buyer.address, USDC(1_000));
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
    const p = await signPermit(s.usdc, buyer, await s.engine.getAddress(), q.permitValue);
    const sig = (await signTyped(buyer, s.checkout, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent)).signature;
    await s.checkout.connect(s.relayer).openPlan(intent, sig, { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s });
    return { buyer, loanId: await s.engine.loanCount() };
  }

  function facts(overrides = {}) {
    return {
      walletAgeDays: 730,
      txCount: 1_200,
      stableBalance: USDC(2_500),
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
  describe("the keeper check", () => {
    it("only the keeper can submit a report", async () => {
      const body = cre.encodeCollectionsReport([]);
      for (const r of [s.collections, s.underwriting]) {
        for (const who of [s.stranger, s.owner, s.relayer]) {
          await expect(r.connect(who).submitReport(body)).to.be.revertedWithCustomError(r, "NotKeeper").withArgs(who.address);
        }
      }
    });

    it("a forged underwriting report from anyone but the keeper opens nothing", async () => {
      const r = await deliver(s.underwriting, cre.encodeUnderwritingReport([{ user: s.stranger.address, facts: facts({ observedAt: await now(), walletAgeDays: 3650, txCount: 500 }) }]), { from: s.stranger });
      expect(r.ok).to.equal(false);
      expect(decodeError(s.underwriting, r.revert).name).to.equal("NotKeeper");
      expect((await s.scores.profileOf(s.stranger.address)).underwritten).to.equal(false);
    });

    it("only the owner rotates the keeper, never to zero, and the old key stops working at once", async () => {
      for (const r of [s.collections, s.underwriting]) {
        await expect(r.connect(s.stranger).setKeeper(s.stranger.address)).to.be.revertedWithCustomError(r, "OwnableUnauthorizedAccount");
        await expect(r.setKeeper(ethers.ZeroAddress)).to.be.revertedWithCustomError(r, "ZeroKeeper");
        await expect(r.setKeeper(s.relayer.address)).to.emit(r, "KeeperSet").withArgs(s.keeper.address, s.relayer.address);
        expect(await r.keeper()).to.equal(s.relayer.address);
        await expect(r.connect(s.keeper).submitReport(cre.encodeCollectionsReport([]))).to.be.revertedWithCustomError(r, "NotKeeper");
      }
      const F = await ethers.getContractFactory("CollectionsReceiver");
      await expect(F.deploy(ethers.ZeroAddress, s.engine, s.payments)).to.be.revertedWithCustomError(F, "ZeroKeeper");
    });

    it("refuses a report of another receiver's kind, naming the kind, even one that would not decode", async () => {
      const r1 = await deliver(s.collections, cre.encodeUnderwritingReport([]));
      expect(decodeError(s.collections, r1.revert)?.args[0]).to.equal(2n);
      const r2 = await deliver(s.underwriting, cre.encodeCollectionsReport([]));
      expect(decodeError(s.underwriting, r2.revert)?.name).to.equal("UnknownReportKind");
      const other = coder.encode(["uint8", "uint256"], [3, 1]);
      for (const r of [s.collections, s.underwriting]) {
        const res = await deliver(r, other);
        expect(decodeError(r, res.revert)?.name).to.equal("UnknownReportKind");
        expect(decodeError(r, res.revert)?.args[0]).to.equal(3n);
        expect(decodeError(r, (await deliver(r, "0x")).revert)?.args[0]).to.equal(0n);
      }
    });
  });

  // ---------------------------------------------------------------------
  describe("CollectionsReceiver", () => {
    it("collects every instalment that fell due in one report; the keeper is just another caller", async () => {
      const a = await buyerWithPlan();
      const b = await buyerWithPlan(USDC(100));
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

    it("only the keeper writes the collections record, but collecting stays permissionless on the engine", async () => {
      const a = await buyerWithPlan();
      await time.increase(WEEK);
      const r = await deliver(s.collections, cre.encodeCollectionsReport([collect(a.loanId)]), { from: s.stranger });
      expect(r.ok).to.equal(false);
      const err = s.collections.interface.parseError(r.revert);
      expect([err.name, err.args[0]]).to.deep.equal(["NotKeeper", s.stranger.address]);
      expect((await s.engine.getLoan(a.loanId)).installmentsPaid).to.equal(0);
      await expect(s.engine.connect(s.stranger).collectInstallment(a.loanId)).to.emit(s.engine, "InstallmentCollected");
    });

    it("the keeper cannot collect more than is due, even by listing a plan twice", async () => {
      const a = await buyerWithPlan();
      await time.increase(WEEK);
      const due = await s.engine.installmentAmount(a.loanId);
      const before = await s.usdc.balanceOf(a.buyer.address);
      const { tx } = await deliver(s.collections, cre.encodeCollectionsReport([collect(a.loanId), collect(a.loanId)]));
      await expect(tx).to.emit(s.collections, "CollectionsRun").withArgs(2, 1, 1);
      await expect(tx)
        .to.emit(s.collections, "TaskSkipped")
        .withArgs(1, a.loanId, s.engine.interface.getError("NotDue").selector);
      expect(await s.usdc.balanceOf(a.buyer.address)).to.equal(before - due);
    });

    it("skips each failing plan with the engine's own reason, so the dunning ladder can tell them apart, and runs the rest", async () => {
      const good = await buyerWithPlan();
      const revoked = await buyerWithPlan();
      const broke = await buyerWithPlan();
      const early = await buyerWithPlan(USDC(100), 2 * WEEK);
      await time.increase(WEEK);

      // One buyer withdraws the allowance, another spends the balance. Both hold no gas,
      // so their token calls are relayed signatures in the app; here we impersonate.
      for (const [w, fn] of [
        [revoked.buyer, (t) => t.approve(s.engine, 0)],
        [broke.buyer, async (t) => t.transfer(s.stranger.address, await s.usdc.balanceOf(broke.buyer.address))],
      ]) {
        await impersonateAccount(w.address);
        await setBalance(w.address, ethers.parseEther("1"));
        await fn(s.usdc.connect(await ethers.getSigner(w.address)));
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
      await s.usdc.mint(buyer.address, USDC(100));
      await s.payments.connect(s.merchant).createPlan(USDC(10), MONTH, "Pro");
      const intent = {
        buyer: buyer.address, merchant: s.merchant.address, planId: 1n, pricePerPeriod: USDC(10),
        periodSeconds: BigInt(MONTH), orderId: "sub", nonce: 0n, deadline: (await now()) + 600n,
      };
      const p = await signPermit(s.usdc, buyer, await s.payments.getAddress(), USDC(120));
      await s.checkout.connect(s.relayer).subscribe(
        intent,
        (await signTyped(buyer, s.checkout, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent)).signature,
        { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s }
      );
      // A plan whose buyer vanished.
      const gone = await buyerWithPlan();
      await impersonateAccount(gone.buyer.address);
      await setBalance(gone.buyer.address, ethers.parseEther("1"));
      await s.usdc.connect(await ethers.getSigner(gone.buyer.address)).approve(s.engine, 0);

      await time.increase(MONTH);
      const tasks = [
        { action: cre.ACTION.CHARGE_SUBSCRIPTION, id: 1n },
        { action: cre.ACTION.LIQUIDATE, id: gone.loanId },
      ];
      expect(await s.collections.checkTasks(tasks)).to.deep.equal([true, true]);
      const { tx } = await deliver(s.collections, cre.encodeCollectionsReport(tasks));
      await expect(tx)
        .to.emit(s.payments, "SubscriptionCharged").withArgs(1n, USDC(10), USDC(0.05), 2)
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

    it("a report that runs out of gas is refused whole, so the keeper can retry it, instead of skipping the buyer", async () => {
      const guzzler = await (await ethers.getContractFactory("GasGuzzler")).deploy();
      const receiver = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(s.keeper.address, guzzler, guzzler);
      const r = await deliver(receiver, cre.encodeCollectionsReport([collect(1n)]), { gasLimit: 3_000_000 });
      expect(r.ok).to.equal(false);
      const err = receiver.interface.parseError(r.revert);
      expect(err.name).to.equal("InsufficientGasForTask");
      expect(err.args[0]).to.equal(0n);
    });

    it("refuses construction without an engine or payments", async () => {
      const F = await ethers.getContractFactory("CollectionsReceiver");
      await expect(F.deploy(s.keeper.address, ethers.ZeroAddress, s.payments)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(s.keeper.address, s.engine, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });

  // ---------------------------------------------------------------------
  describe("UnderwritingReceiver", () => {
    beforeEach(async () => {
      await s.scores.setRequireUnderwriting(true);
    });

    it("a keeper report of facts opens the first line; the score is computed on chain, never reported", async () => {
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
      expect(await s.scores.creditLimitOf(user)).to.equal(USDC(500));
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
      expect(await s.scores.creditLimitOf(accounts[0])).to.equal(USDC(500));
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
      expect(await s.scores.creditLimitOf(account)).to.equal(USDC(500));

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

    it("the receiver is the only underwriter: the relayer, the owner and the collections receiver are refused", async () => {
      const f = facts({ observedAt: await now() });
      for (const who of [s.relayer, s.owner]) {
        await expect(s.scores.connect(who).underwrite(who.address, f)).to.be.revertedWithCustomError(s.scores, "NotUnderwriter");
      }
      expect(await s.scores.isUnderwriter(await s.collections.getAddress())).to.equal(false);
    });

    it("a report that runs out of gas is refused whole", async () => {
      const guzzler = await (await ethers.getContractFactory("GasGuzzler")).deploy();
      const receiver = await (await ethers.getContractFactory("UnderwritingReceiver")).deploy(s.keeper.address, guzzler);
      const r = await deliver(receiver, cre.encodeUnderwritingReport([{ user: s.stranger.address, facts: facts() }]), { gasLimit: 3_000_000 });
      expect(r.ok).to.equal(false);
      expect(receiver.interface.parseError(r.revert).name).to.equal("InsufficientGasForItem");
    });

    it("decodes exactly the report the keeper encodes", async () => {
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
  describe("lib/keeper.js: one report format per receiver, encoded and decoded", () => {
    it("round-trips a collections report, including the instant retry's", () => {
      const tasks = [collect(7n), { action: cre.ACTION.CHARGE_SUBSCRIPTION, id: 2n }, { action: cre.ACTION.LIQUIDATE, id: 2n ** 200n }];
      const body = cre.encodeCollectionsReport(tasks);
      expect(cre.reportKind(body)).to.equal(cre.REPORT_KIND.COLLECTIONS);
      expect(cre.decodeCollectionsReport(body)).to.deep.equal({ kind: 1, tasks });
      expect(cre.decodeCollectionsReport(cre.encodeCollectionsReport([]))).to.deep.equal({ kind: 1, tasks: [] });
    });

    it("round-trips an underwriting report", () => {
      const f = { ...facts({ observedAt: 99n }), stableBalance: USDC(12) };
      const items = [{ user: s.stranger.address, linkedWallet: s.relayer.address, facts: f }];
      const decoded = cre.decodeUnderwritingReport(cre.encodeUnderwritingReport(items));
      expect(decoded.kind).to.equal(2);
      expect(decoded.items[0].user).to.equal(s.stranger.address);
      expect(decoded.items[0].linkedWallet).to.equal(s.relayer.address);
      expect(decoded.items[0].facts).to.deep.equal(f);
    });

  });
});
