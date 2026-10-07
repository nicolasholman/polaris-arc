/**
 * The CRE credit guard: GuardianReceiver (the `polaris-guardian` workflow's
 * receiver) and the check PolarisCheckout.openPlan makes against it.
 *
 * Attestations here are hand-built in the report format the workflow writes
 * (lib/cre.js) and delivered through a MockKeystoneForwarder by the simulation
 * transmitter, as `cre workflow simulate --broadcast` delivers them. The price
 * comes from a local MockPriceFeed standing in for Chainlink's AUSD/USD feed on
 * Monad mainnet. Tests are named for what each refuses or guarantees.
 *
 * What the receiver trusts the DON for is the price alone: low cash and bad
 * debt are read from the pool in the same call (never stale, never set or
 * cleared by a report), and a report whose pool verdict is not the live
 * pool's is refused. A PoolDouble stands in for the pool where a test needs
 * pool figures no loan book here would reach.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { signTyped, signPermit, signReceive, paymentId } = require("../helpers/sign");
const { TYPES } = require("../../lib/eip712");
const cre = require("../../lib/cre");

const AUSD = (n) => ethers.parseUnits(String(n), 6);
const PRICE = (n) => ethers.parseUnits(String(n), 8);
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const { DEPEG, LOW_CASH, BAD_DEBT, STALE_PRICE, OWNER_PAUSE } = cre.GUARDIAN_REASON;
const OVERRIDE = cre.GUARDIAN_OVERRIDE;

/** lib/cre.js GUARDIAN_DEFAULTS as GuardianReceiver.Thresholds. */
const DEFAULTS = cre.guardianThresholds();
/** The same thresholds as `thresholds()` returns them, in field order. */
const tuple = (t) => cre.GUARDIAN_THRESHOLD_FIELDS.map((f) => BigInt(t[f]));

async function deployStack() {
  const [owner, relayer, merchant, treasury, stranger, don, workflowOwner] = await ethers.getSigners();
  const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, ausd, scores, treasury.address, DAY, 60);
  const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, ausd, treasury.address, 60);
  const send = await (await ethers.getContractFactory("PolarisSend")).deploy(ausd);
  const checkout = await (await ethers.getContractFactory("PolarisCheckout")).deploy(owner.address, engine, payments, scores);
  const forwarder = await (await ethers.getContractFactory("MockKeystoneForwarder")).deploy();
  const guardian = await (await ethers.getContractFactory("GuardianReceiver")).deploy(
    forwarder, engine, don.address, DEFAULTS, cre.GUARDIAN_DEFAULTS.maxAttestationAge
  );
  const collections = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(forwarder, engine, payments, don.address);
  const feed = await (await ethers.getContractFactory("MockPriceFeed")).deploy(8, "AUSD / USD (local mock)", PRICE("0.9998"));

  await scores.setWriter(engine, true);
  await engine.setOriginator(checkout, true);
  await payments.setCheckout(checkout);
  await checkout.setCreditGuardian(guardian);
  await ausd.mint(owner.address, AUSD(100_000));
  await ausd.approve(engine, AUSD(100_000));
  await engine.fund(AUSD(50_000));

  return { ausd, scores, engine, payments, send, checkout, forwarder, guardian, collections, feed, owner, relayer, merchant, treasury, stranger, don, workflowOwner };
}

describe("The CRE credit guard (GuardianReceiver)", () => {
  let s;

  beforeEach(async () => {
    s = await loadFixture(deployStack);
  });

  const now = async () => BigInt(await time.latest());

  /** Deliver `body` to `receiver` through the mock forwarder, as the simulator does. */
  async function deliver(receiver, body, { from = s.don, workflowName = cre.WORKFLOW_NAMES.GUARDIAN, workflowOwner, workflowId } = {}) {
    const raw = cre.encodeRawReport({
      body,
      workflowName,
      workflowOwner: workflowOwner ?? s.workflowOwner.address,
      workflowId: workflowId ?? ethers.ZeroHash,
      executionId: ethers.hexlify(ethers.randomBytes(32)),
      timestamp: Number(await now()),
    });
    const tx = await s.forwarder.connect(from).report(await receiver.getAddress(), raw, "0x", []);
    const receipt = await tx.wait();
    const processed = receipt.logs
      .map((l) => { try { return s.forwarder.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ReportProcessed");
    return { tx, receipt, ok: processed.args.result, revert: await s.forwarder.lastRevertData() };
  }

  /**
   * An attestation of the pool now at the feed's latest round, with the
   * verdict computed as the workflow does from `currentInputs()` (the pool,
   * the thresholds the guardian holds now, the bad debt acknowledged),
   * unless `fields` overrides it.
   */
  async function attestation(fields = {}, guardian = s.guardian) {
    const [pool, thresholds, acknowledged] = await guardian.currentInputs();
    const [roundId, answer, , updatedAt] = await s.feed.latestRoundData();
    const a = cre.buildAttestation(
      { price: answer, priceRoundId: roundId, priceUpdatedAt: updatedAt, pool, observedAt: await now() },
      thresholds,
      acknowledged
    );
    const merged = { ...a, ...fields };
    if (!("reasons" in fields) && !("creditPaused" in fields)) {
      merged.reasons = cre.guardianReasons(merged, thresholds, acknowledged);
      merged.creditPaused = merged.reasons !== 0;
    }
    return merged;
  }

  const attest = async (fields, opts) => deliver(s.guardian, cre.encodeGuardianReport(await attestation(fields)), opts);

  /** A GuardianReceiver over a PoolDouble whose figures the test sets. */
  async function guardianOverDouble(thresholds = DEFAULTS) {
    const pool = await (await ethers.getContractFactory("PoolDouble")).deploy(await s.ausd.getAddress());
    const guardian = await (await ethers.getContractFactory("GuardianReceiver")).deploy(
      s.forwarder, pool, s.don.address, thresholds, cre.GUARDIAN_DEFAULTS.maxAttestationAge
    );
    return { pool, guardian };
  }

  /** The owner's forced resume, lasting `seconds` from the next block. */
  const resumeFor = async (guardian, seconds = 3_600) => guardian.setOverride(OVERRIDE.FORCE_RESUME, (await now()) + BigInt(seconds));

  /** A fresh gasless buyer with a credit line; returns what openPlan needs. */
  async function planArgs(buyer, principal = AUSD(100)) {
    const intent = {
      buyer: buyer.address,
      merchant: s.merchant.address,
      principal,
      installments: 4,
      interval: BigInt(WEEK),
      orderId: `o-${Math.random()}`,
      nonce: await s.checkout.nonces(buyer.address),
      deadline: (await now()) + 600n,
    };
    const q = await s.checkout.quotePlan(buyer.address, principal, 4, WEEK);
    const p = await signPermit(s.ausd, buyer, await s.engine.getAddress(), q.permitValue);
    const sig = (await signTyped(buyer, s.checkout, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent)).signature;
    return [intent, sig, { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s }];
  }

  async function newBuyer() {
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    await s.ausd.mint(buyer.address, AUSD(1_000));
    return buyer;
  }

  const refusal = (receipt) =>
    receipt.logs
      .map((l) => { try { return s.guardian.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "AttestationRefused");

  // ---------------------------------------------------------------------
  describe("attestations", () => {
    it("accepts the workflow's attestation of a healthy pool and publishes it", async () => {
      const a = await attestation();
      expect(a.reasons).to.equal(0);
      const { tx, ok } = await deliver(s.guardian, cre.encodeGuardianReport(a));
      expect(ok).to.equal(true);
      await expect(tx).to.emit(s.guardian, "CreditGuardUpdated");
      const ev = (await tx.wait()).logs.map((l) => { try { return s.guardian.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "CreditGuardUpdated");
      expect(ev.args.round).to.equal(1n);
      expect(ev.args.creditPaused).to.equal(false);
      expect(ev.args.attestation.price).to.equal(PRICE("0.9998"));
      expect(ev.args.attestation.freeCash).to.equal(AUSD(50_000));

      const stored = await s.guardian.latestAttestation();
      for (const f of cre.ATTESTATION_FIELDS) expect(stored[f], f).to.equal(f === "reasons" ? BigInt(a[f]) : a[f]);
      const st = await s.guardian.creditStatus();
      expect([st.paused, st.stale, st.round, st.observedAt]).to.deep.equal([false, false, 1n, a.observedAt]);
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
    });

    it("a depeg pauses new Pay in 4 plans, and the next healthy report resumes them", async () => {
      await s.feed.setAnswer(PRICE("0.99"));
      const paused = await attest();
      expect(paused.ok).to.equal(true);
      await expect(paused.tx).to.emit(s.guardian, "CreditGuardUpdated").withArgs(1n, true, DEPEG, (x) => x.price === PRICE("0.99"));
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG)]);

      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer))))
        .to.be.revertedWithCustomError(s.checkout, "CreditPausedByGuardian")
        .withArgs(DEPEG);

      await s.feed.setAnswer(PRICE("0.9999"));
      await time.increase(60);
      await attest();
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");
    });

    it("pauses for low pool cash and a stale price too, and reports every reason at once", async () => {
      // Low cash: a pool of $50,000 against a $60,000 floor. Read from the pool, it pauses before any report.
      await s.guardian.setThresholds({ ...DEFAULTS, minFreeCash: AUSD(60_000) });
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(LOW_CASH)]);
      await attest();
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(LOW_CASH)]);
      await s.guardian.setThresholds(DEFAULTS);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([false, 0n]);

      // A price round older than two hours at observation.
      await s.feed.setRound(PRICE("1"), (await now()) - 7_201n);
      await time.increase(10);
      await attest();
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(STALE_PRICE)]);

      // Everything the engine's pool can show at once: a depeg, a stale price, low cash.
      await s.guardian.setThresholds({ ...DEFAULTS, minFreeCash: AUSD(60_000) });
      await s.feed.setRound(PRICE("0.97"), (await now()) - 3n * 3600n);
      await time.increase(10);
      await attest();
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG | LOW_CASH | STALE_PRICE)]);
      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer))))
        .to.be.revertedWithCustomError(s.checkout, "CreditPausedByGuardian")
        .withArgs(DEPEG | LOW_CASH | STALE_PRICE);
      const st = await s.guardian.creditStatus();
      expect([st.poolReasons, st.priceReasons]).to.deep.equal([BigInt(LOW_CASH), BigInt(DEPEG | STALE_PRICE)]);
    });

    it("bad debt above 5% of lifetime originations pauses, from the pool itself, with every reason at once", async () => {
      const { pool, guardian } = await guardianOverDouble();
      // $20,000 lent, $1,001 lost (just over 5%), $500 of free cash.
      await pool.setState(AUSD(500), AUSD(3_000), AUSD(1_001), AUSD(20_000));
      expect(await guardian.isCreditPaused()).to.deep.equal([true, BigInt(LOW_CASH | BAD_DEBT)]);
      await pool.setState(AUSD(5_000), AUSD(3_000), AUSD(1_000), AUSD(20_000)); // exactly 5% is not above it
      expect(await guardian.isCreditPaused()).to.deep.equal([false, 0n]);

      await pool.setState(AUSD(10), AUSD(100), AUSD(10_000), AUSD(10_000));
      await s.feed.setRound(PRICE("0.97"), (await now()) - 3n * 3600n);
      const a = await attestation({}, guardian);
      expect(a.reasons).to.equal(DEPEG | LOW_CASH | BAD_DEBT | STALE_PRICE);
      const r = await deliver(guardian, cre.encodeGuardianReport(a));
      expect(r.ok).to.equal(true);
      expect(await guardian.latestRound()).to.equal(1n);
      expect(await guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG | LOW_CASH | BAD_DEBT | STALE_PRICE)]);
    });

    it("refuses a verdict that is not the chain's own: the workflow cannot call a depegged pool healthy, or pause a healthy one", async () => {
      await s.feed.setAnswer(PRICE("0.99"));
      const lie = await attest({ creditPaused: false, reasons: 0 });
      expect(lie.ok).to.equal(true, "refused by event, not by revert");
      const e = refusal(lie.receipt);
      expect(e.args.reason).to.equal(s.guardian.interface.encodeErrorResult("VerdictMismatch", [false, 0, DEPEG]));
      expect((await s.guardian.creditStatus()).round).to.equal(0n);

      await s.feed.setAnswer(PRICE("1"));
      for (const fields of [{ creditPaused: true, reasons: 0 }, { creditPaused: true, reasons: LOW_CASH }, { creditPaused: false, reasons: DEPEG }]) {
        const r = await attest(fields);
        expect(refusal(r.receipt).args.reason.slice(0, 10)).to.equal(s.guardian.interface.getError("VerdictMismatch").selector);
      }
      expect(await s.guardian.latestRound()).to.equal(0n);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([false, 0n]);
    });

    // Judge finding (GuardianReceiver trusted the report's pool figures): whoever
    // produced a report could pause credit by reporting freeCash = 0, or keep it
    // open through a real shortfall.
    it("refuses a report whose pool is not the chain's: no free cash against a funded pool cannot pause credit", async () => {
      const lie = await attestation({ freeCash: 0n }); // the verdict recomputed: LOW_CASH, self-consistent
      expect(lie.reasons).to.equal(LOW_CASH);
      const r = await deliver(s.guardian, cre.encodeGuardianReport(lie));
      expect(r.ok).to.equal(true, "refused by event, not by revert");
      expect(refusal(r.receipt).args.reason).to.equal(s.guardian.interface.encodeErrorResult("PoolMismatch", [LOW_CASH, 0]));
      expect(await s.guardian.latestRound()).to.equal(0n);
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");

      // Nor keep it open through a real shortfall: the pool reads low, the report says ample.
      await s.guardian.setThresholds({ ...DEFAULTS, minFreeCash: AUSD(60_000) });
      const ample = await attestation({ freeCash: AUSD(70_000) });
      expect(ample.reasons).to.equal(0);
      const r2 = await deliver(s.guardian, cre.encodeGuardianReport(ample));
      expect(refusal(r2.receipt).args.reason).to.equal(s.guardian.interface.encodeErrorResult("PoolMismatch", [0, LOW_CASH]));
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(LOW_CASH)]);
    });

    it("never fails open on the pool: low cash and bad debt apply with no attestation, or a stale one", async () => {
      const { pool, guardian } = await guardianOverDouble({ ...DEFAULTS, minOriginated: 0n });
      await pool.setState(AUSD(50_000), 0n, 0n, 0n);
      expect((await guardian.creditStatus()).stale).to.equal(true);
      expect(await guardian.isCreditPaused()).to.deep.equal([false, 0n]);
      await pool.setState(AUSD(999), AUSD(100), 0n, AUSD(100));
      expect(await guardian.isCreditPaused()).to.deep.equal([true, BigInt(LOW_CASH)], "no attestation yet");
      await pool.setState(AUSD(50_000), 0n, AUSD(6), AUSD(100));
      expect(await guardian.isCreditPaused()).to.deep.equal([true, BigInt(BAD_DEBT)], "no attestation yet");

      // A depeg attested, then gone stale: the price reason fails open, the pool's does not.
      await s.feed.setAnswer(PRICE("0.9"));
      await deliver(guardian, cre.encodeGuardianReport(await attestation({}, guardian)));
      expect(await guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG | BAD_DEBT)]);
      await time.increase(3_601);
      const st = await guardian.creditStatus();
      expect([st.stale, st.paused, st.reasons, st.poolReasons, st.priceReasons]).to.deep.equal([true, true, BigInt(BAD_DEBT), BigInt(BAD_DEBT), 0n]);
    });

    it("refuses a replayed, out-of-order, future-dated or already stale attestation", async () => {
      const first = await attestation();
      await deliver(s.guardian, cre.encodeGuardianReport(first));
      // The mock forwarder has no replay guard; the receiver does.
      const replay = await deliver(s.guardian, cre.encodeGuardianReport(first));
      expect(refusal(replay.receipt).args.reason).to.equal(
        s.guardian.interface.encodeErrorResult("AttestationOutOfOrder", [first.observedAt, first.observedAt])
      );
      const older = await deliver(s.guardian, cre.encodeGuardianReport({ ...first, observedAt: first.observedAt - 5n }));
      expect(refusal(older.receipt).args.reason.slice(0, 10)).to.equal(s.guardian.interface.getError("AttestationOutOfOrder").selector);

      const future = await attestation({ observedAt: (await now()) + 3_600n });
      const fut = await deliver(s.guardian, cre.encodeGuardianReport(future));
      expect(refusal(fut.receipt).args.reason.slice(0, 10)).to.equal(s.guardian.interface.getError("ObservationInFuture").selector);

      await time.increase(4_000);
      const stale = await attestation({ observedAt: first.observedAt + 1n });
      const old = await deliver(s.guardian, cre.encodeGuardianReport(stale));
      expect(refusal(old.receipt).args.reason).to.equal(
        s.guardian.interface.encodeErrorResult("AttestationTooOld", [first.observedAt + 1n, 3_600])
      );
      expect(await s.guardian.latestRound()).to.equal(1n);
    });

    it("fails open: once the latest attestation is older than maxAttestationAge, Pay in 4 works again", async () => {
      const buyer = await newBuyer();
      // No attestation yet: open.
      expect((await s.guardian.creditStatus()).stale).to.equal(true);
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);

      await s.feed.setAnswer(PRICE("0.98"));
      await attest();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.be.revertedWithCustomError(s.checkout, "CreditPausedByGuardian");

      const observedAt = (await s.guardian.creditStatus()).observedAt;
      await time.increaseTo(observedAt + 3_590n); // inside maxAttestationAge: still paused
      expect((await s.guardian.isCreditPaused())[0]).to.equal(true);
      await time.increaseTo(observedAt + 3_610n);
      const st = await s.guardian.creditStatus();
      expect([st.stale, st.paused, st.attestedPaused, st.attestedReasons]).to.deep.equal([true, false, true, BigInt(DEPEG)]);
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");

      // The staleness is the owner's to set.
      await expect(s.guardian.setMaxAttestationAge(2 * 3600)).to.emit(s.guardian, "MaxAttestationAgeSet").withArgs(7200);
      expect((await s.guardian.isCreditPaused())[0]).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------
  describe("the owner's controls", () => {
    it("forces a pause over a healthy attestation, forces a resume over a depeg, and hands back to the attestations", async () => {
      const buyer = await newBuyer();
      await attest();
      await expect(s.guardian.setOverride(OVERRIDE.FORCE_PAUSE, 0)).to.emit(s.guardian, "CreditGuardOverridden").withArgs(OVERRIDE.FORCE_PAUSE, 0);
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer))))
        .to.be.revertedWithCustomError(s.checkout, "CreditPausedByGuardian")
        .withArgs(OWNER_PAUSE);

      await s.feed.setAnswer(PRICE("0.9"));
      await time.increase(10);
      await attest();
      await resumeFor(s.guardian);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([false, 0n]);
      const st = await s.guardian.creditStatus();
      expect([st.overrideMode, st.attestedPaused]).to.deep.equal([BigInt(OVERRIDE.FORCE_RESUME), true]);
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");

      await s.guardian.setOverride(OVERRIDE.NONE, 0);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG)]);
    });

    // Security review F1: ForceResume switched off every reason with no end, so
    // a resume set for one borrower's default outlived a later depeg.
    it("a forced resume ends by itself, at most a day ahead; a pause and None take no end", async () => {
      const t0 = await now();
      for (const until of [0n, t0, t0 + BigInt(DAY) + 100n]) {
        await expect(s.guardian.setOverride(OVERRIDE.FORCE_RESUME, until)).to.be.revertedWithCustomError(s.guardian, "InvalidOverride");
      }
      for (const mode of [OVERRIDE.FORCE_PAUSE, OVERRIDE.NONE]) {
        await expect(s.guardian.setOverride(mode, t0 + 100n)).to.be.revertedWithCustomError(s.guardian, "InvalidOverride");
      }
      await s.feed.setAnswer(PRICE("0.9"));
      await attest();
      const until = (await now()) + 600n;
      await expect(s.guardian.setOverride(OVERRIDE.FORCE_RESUME, until)).to.emit(s.guardian, "CreditGuardOverridden").withArgs(OVERRIDE.FORCE_RESUME, until);
      let st = await s.guardian.creditStatus();
      expect([st.paused, st.overrideMode, st.overrideUntil]).to.deep.equal([false, BigInt(OVERRIDE.FORCE_RESUME), until]);
      await time.increaseTo(until);
      st = await s.guardian.creditStatus();
      expect([st.paused, st.reasons, st.overrideMode, st.overrideUntil]).to.deep.equal([true, BigInt(DEPEG), BigInt(OVERRIDE.NONE), 0n]);
      expect(await s.guardian.activeOverride()).to.equal(BigInt(OVERRIDE.NONE));
      expect(await s.guardian.overrideMode()).to.equal(BigInt(OVERRIDE.FORCE_RESUME), "as set; activeOverride() is what applies");
    });

    // Security review F1, on the real engine: one $100 plan, the pool's only
    // origination, defaults with nothing recovered: 100% bad debt.
    it("one default on a young pool does not pause everyone; acknowledged bad debt lifts a bad-debt pause, and a depeg still pauses", async () => {
      const buyer = await newBuyer();
      await s.owner.sendTransaction({ to: buyer.address, value: ethers.parseEther("1") });
      await s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer, AUSD(100))));
      const loanId = await s.engine.loanCount();
      await s.ausd.connect(buyer).approve(s.engine, 0);
      await time.increase(WEEK + DAY + 10);
      await s.engine.liquidate(loanId);
      await s.feed.setAnswer(PRICE("0.9998")); // a fresh round after the weeks that passed
      const pool = await s.engine.poolState();
      expect(pool.badDebt).to.equal(pool.totalOriginated);

      // Under the $10,000 floor the ratio is not applied: one loss is not a portfolio.
      expect(pool.totalOriginated < DEFAULTS.minOriginated).to.equal(true);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([false, 0n]);
      // Without the floor, the loss pauses Pay in 4 for every buyer, as it did before.
      await s.guardian.setThresholds({ ...DEFAULTS, minOriginated: 0n });
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(BAD_DEBT)]);
      await attest();
      await time.increase(60);
      await attest();
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(BAD_DEBT)], "later reports don't lift it");

      // The owner acknowledges the loss: only bad debt beyond it counts from now on.
      await expect(s.guardian.acknowledgeBadDebt()).to.emit(s.guardian, "BadDebtAcknowledged").withArgs(pool.badDebt);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([false, 0n]);
      const [, , acknowledged] = await s.guardian.currentInputs();
      expect(acknowledged).to.equal(pool.badDebt);
      expect((await s.guardian.creditStatus()).badDebtAcknowledged).to.equal(pool.badDebt);

      // ...and a depeg still pauses: nothing about the price was switched off.
      await s.feed.setAnswer(PRICE("0.90"));
      await time.increase(60);
      const depeg = await attest();
      expect(depeg.ok).to.equal(true);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG)]);
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(await newBuyer()))))
        .to.be.revertedWithCustomError(s.checkout, "CreditPausedByGuardian")
        .withArgs(DEPEG);
      await expect(s.guardian.connect(s.stranger).acknowledgeBadDebt()).to.be.revertedWithCustomError(s.guardian, "OwnableUnauthorizedAccount");
    });

    it("sets the thresholds and the staleness with events, within sane bounds, and only the owner can", async () => {
      // Decision 28: a demo raises the peg threshold so the real price trips it.
      const demo = { ...DEFAULTS, minPrice: PRICE("1.001"), maxPrice: PRICE("1.01") };
      await expect(s.guardian.setThresholds(demo)).to.emit(s.guardian, "ThresholdsSet").withArgs(tuple(demo));
      expect(await s.guardian.thresholds()).to.deep.equal(tuple(demo));
      await attest();
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG)]);

      for (const bad of [
        { minPrice: 0n },
        { minPrice: -1n },
        { minPrice: PRICE("1.01"), maxPrice: PRICE("1.005") },
        { maxPrice: PRICE("2.01") },
        { maxBadDebtBps: 10_001 },
        { maxPriceAge: 0 },
      ]) {
        await expect(s.guardian.setThresholds({ ...DEFAULTS, ...bad })).to.be.revertedWithCustomError(s.guardian, "InvalidThresholds");
      }
      for (const age of [0, 7 * DAY + 1]) {
        await expect(s.guardian.setMaxAttestationAge(age)).to.be.revertedWithCustomError(s.guardian, "InvalidMaxAttestationAge").withArgs(age);
      }
      for (const call of [
        () => s.guardian.connect(s.stranger).setThresholds(DEFAULTS),
        () => s.guardian.connect(s.stranger).setMaxAttestationAge(60),
        () => s.guardian.connect(s.stranger).setOverride(OVERRIDE.FORCE_PAUSE, 0),
        () => s.guardian.connect(s.stranger).setSimulationTransmitter(s.stranger.address),
        () => s.checkout.connect(s.stranger).setCreditGuardian(ethers.ZeroAddress),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(s.guardian, "OwnableUnauthorizedAccount");
      }
    });

    // Security review F3: the stored verdict was returned as is, so a threshold
    // change did nothing until the next accepted report.
    it("a threshold change applies at once to the latest attestation's price, both ways", async () => {
      await attest(); // AUSD $0.9998: healthy
      await s.guardian.setThresholds({ ...DEFAULTS, minPrice: PRICE("1.001") });
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG)], "raised: paused with no new report");
      await attest();
      await s.guardian.setThresholds(DEFAULTS);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([false, 0n], "restored: open with no new report");
      const st = await s.guardian.creditStatus();
      expect([st.attestedPaused, st.attestedReasons, st.priceReasons]).to.deep.equal([true, BigInt(DEPEG), 0n], "the record keeps what the workflow said");
    });

    // Security review F4: the price only had a floor, and an absurd answer made
    // every round write revert, so a faulty feed could only ever go stale.
    it("a price above the ceiling is a depeg, and no answer makes a round write revert", async () => {
      await s.feed.setAnswer(PRICE("1.25"));
      expect((await attestation()).reasons).to.equal(DEPEG);
      const up = await attest();
      expect(up.ok).to.equal(true);
      expect(await s.guardian.isCreditPaused()).to.deep.equal([true, BigInt(DEPEG)]);

      await s.feed.setAnswer((1n << 200n) + 7n);
      await time.increase(10);
      const absurd = await attest();
      expect(absurd.ok).to.equal(true, "the forwarder recorded result=true");
      expect(await s.guardian.latestRound()).to.equal(2n);
      const [, answer] = await s.guardian.latestRoundData();
      expect(answer).to.equal(0n, "paused: nothing to lend");

      // A healthy price against an enormous balance saturates instead of reverting.
      const { pool, guardian } = await guardianOverDouble();
      await pool.setState(ethers.MaxUint256 / 3n, 0n, 0n, 0n);
      await s.feed.setAnswer(PRICE("1"));
      const a = await attestation({}, guardian);
      expect(a.reasons).to.equal(0);
      expect((await deliver(guardian, cre.encodeGuardianReport(a))).ok).to.equal(true);
      const [, big] = await guardian.latestRoundData();
      expect(big).to.equal((1n << 191n) - 1n);
    });

    it("the checkout's guardian is the owner's to set, must be a contract, and can be removed", async () => {
      await expect(s.checkout.setCreditGuardian(s.stranger.address)).to.be.revertedWithCustomError(s.checkout, "GuardianNotAContract");
      await s.feed.setAnswer(PRICE("0.5"));
      await attest();
      await expect(s.checkout.setCreditGuardian(ethers.ZeroAddress)).to.emit(s.checkout, "CreditGuardianSet").withArgs(ethers.ZeroAddress);
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
    });

    it("a guardian that reverts or answers nonsense fails open rather than blocking Pay in 4", async () => {
      await s.checkout.setCreditGuardian(s.feed); // a contract with no isCreditPaused
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");
    });
  });

  // ---------------------------------------------------------------------
  describe("the owner's script (lib/guardian.js, guardian:monad)", () => {
    const { guardianStatus, runGuardianAction, reasonWords } = require("../../lib/guardian");
    const { guardianConfig } = require("../../scripts/deploy-monad");

    it("raises the peg for the demo, forces and clears an override, and reports the guard in words", async () => {
      expect((await guardianStatus(s.guardian)).latest).to.equal(null);
      await runGuardianAction(s.guardian, "thresholds", { config: guardianConfig({ GUARD_MIN_PRICE: "1.001" }) });
      await attest();
      let st = await guardianStatus(s.guardian);
      expect([st.paused, st.reasonWords, st.thresholds.minPrice]).to.deep.equal([true, ["depeg"], "100100000"]);
      expect(st.latest.price).to.equal(PRICE("0.9998").toString());

      await runGuardianAction(s.guardian, "override", { override: "resume", resumeSeconds: 600 });
      st = await guardianStatus(s.guardian);
      expect([st.paused, st.override]).to.deep.equal([false, "resume"]);
      expect(st.overrideUntil - Number(await now())).to.be.within(598, 600);
      for (const resumeSeconds of [0, 24 * 3600 + 1, "soon"]) {
        let bad;
        try {
          await runGuardianAction(s.guardian, "override", { override: "resume", resumeSeconds });
        } catch (e) {
          bad = e;
        }
        expect(bad?.message, String(resumeSeconds)).to.match(/GUARD_RESUME_SECONDS/);
      }
      await runGuardianAction(s.guardian, "override", { override: "none" });
      await runGuardianAction(s.guardian, "thresholds", { config: guardianConfig({}) });
      await runGuardianAction(s.guardian, "max-age", { config: guardianConfig({ GUARD_MAX_ATTESTATION_AGE_SECONDS: "900" }) });
      st = await guardianStatus(s.guardian);
      expect([st.thresholds.minPrice, st.thresholds.maxPrice, st.thresholds.minOriginated, st.maxAttestationAge, st.override]).to.deep.equal([
        "99500000",
        "100500000",
        "10000000000",
        900,
        "none",
      ]);
      await runGuardianAction(s.guardian, "acknowledge");
      expect((await guardianStatus(s.guardian)).badDebtAcknowledged).to.equal("0");

      expect(reasonWords(DEPEG | STALE_PRICE | OWNER_PAUSE)).to.deep.equal(["depeg", "stale price", "paused by the owner"]);
      let err;
      try {
        await runGuardianAction(s.guardian, "override", { override: "sideways" });
      } catch (e) {
        err = e;
      }
      expect(err?.message).to.match(/GUARD_OVERRIDE/);
    });
  });

  // ---------------------------------------------------------------------
  describe("pool health as a feed (AggregatorV3Interface)", () => {
    it("reads like a Chainlink feed: 8 decimals, a round per attestation, what the pool can lend in dollars", async () => {
      const feedView = await ethers.getContractAt("AggregatorV3Interface", await s.guardian.getAddress());
      expect(await feedView.decimals()).to.equal(8n);
      expect(await feedView.description()).to.equal("Polaris pool health, computed by CRE");
      expect(await feedView.version()).to.equal(1n);
      expect(await feedView.latestRoundData()).to.deep.equal([0n, 0n, 0n, 0n, 0n]);

      const a = await attestation();
      await deliver(s.guardian, cre.encodeGuardianReport(a));
      const lendable = (AUSD(50_000) * PRICE("0.9998")) / 10n ** 6n; // $49,990 with 8 decimals
      expect(await feedView.latestRoundData()).to.deep.equal([1n, lendable, a.observedAt, a.observedAt, 1n]);

      await s.feed.setAnswer(PRICE("0.9"));
      await time.increase(30);
      const b = await attestation();
      await deliver(s.guardian, cre.encodeGuardianReport(b));
      expect(await feedView.latestRoundData()).to.deep.equal([2n, 0n, b.observedAt, b.observedAt, 2n], "nothing to lend while paused");
      expect(await feedView.getRoundData(1)).to.deep.equal([1n, lendable, a.observedAt, a.observedAt, 1n], "a round never changes");
      for (const id of [0, 3]) {
        await expect(feedView.getRoundData(id)).to.be.revertedWithCustomError(s.guardian, "RoundNotFound").withArgs(id);
      }
    });
  });

  // ---------------------------------------------------------------------
  describe("the verdict formula", () => {
    it("evaluate() on chain and guardianReasons() in lib/cre.js agree, on edges and on random attestations", async () => {
      const t0 = await now();
      const edges = [
        { price: DEFAULTS.minPrice, freeCash: DEFAULTS.minFreeCash, badDebt: 50n, totalOriginated: 1_000n, priceUpdatedAt: t0 - 7_200n, observedAt: t0 },
        { price: DEFAULTS.minPrice - 1n, freeCash: DEFAULTS.minFreeCash - 1n, badDebt: 51n, totalOriginated: 1_000n, priceUpdatedAt: t0 - 7_201n, observedAt: t0 },
        { price: 0n, freeCash: 0n, badDebt: 1n, totalOriginated: 0n, priceUpdatedAt: 0n, observedAt: t0 },
        { price: -5n, freeCash: 10n ** 30n, badDebt: 0n, totalOriginated: 0n, priceUpdatedAt: t0 + 60n, observedAt: t0 },
        { price: PRICE("2"), freeCash: AUSD(1), badDebt: 10n ** 20n, totalOriginated: 10n ** 21n - 1n, priceUpdatedAt: 1n, observedAt: 7_202n },
      ];
      let seed = 42;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const pick = (...xs) => xs[Math.floor(rnd() * xs.length)];
      const random = Array.from({ length: 120 }, () => ({
        price: pick(0n, DEFAULTS.minPrice - 1n, DEFAULTS.minPrice, PRICE("1"), BigInt(Math.floor(rnd() * 2e8)) - 1000n),
        freeCash: pick(0n, DEFAULTS.minFreeCash - 1n, DEFAULTS.minFreeCash, BigInt(Math.floor(rnd() * 1e12))),
        badDebt: BigInt(Math.floor(rnd() * 1e9)),
        totalOriginated: pick(0n, BigInt(Math.floor(rnd() * 3e10))),
        priceUpdatedAt: pick(0n, t0, t0 - 7_200n, t0 - 7_201n, t0 - BigInt(Math.floor(rnd() * 20_000))),
        observedAt: t0,
      }));
      // Edges of the ceiling and the originations floor.
      edges.push(
        { price: DEFAULTS.maxPrice, freeCash: AUSD(5_000), badDebt: 0n, totalOriginated: 0n, priceUpdatedAt: t0, observedAt: t0 },
        { price: DEFAULTS.maxPrice + 1n, freeCash: AUSD(5_000), badDebt: 0n, totalOriginated: 0n, priceUpdatedAt: t0, observedAt: t0 },
        { price: PRICE("1"), freeCash: AUSD(5_000), badDebt: AUSD(501), totalOriginated: DEFAULTS.minOriginated - 1n, priceUpdatedAt: t0, observedAt: t0 },
        { price: PRICE("1"), freeCash: AUSD(5_000), badDebt: AUSD(501), totalOriginated: DEFAULTS.minOriginated, priceUpdatedAt: t0, observedAt: t0 },
        { price: PRICE("1"), freeCash: AUSD(5_000), badDebt: AUSD(500), totalOriginated: DEFAULTS.minOriginated, priceUpdatedAt: t0, observedAt: t0 }
      );
      const thresholdSets = [
        DEFAULTS,
        { minPrice: PRICE("1.001"), maxPrice: PRICE("1.001"), minFreeCash: 0n, maxBadDebtBps: 0, minOriginated: 0n, maxPriceAge: 1 },
        { ...DEFAULTS, maxBadDebtBps: 10_000, maxPrice: PRICE("2") },
        { ...DEFAULTS, minOriginated: AUSD(1_000) },
      ];
      for (const th of thresholdSets) {
        await s.guardian.setThresholds(th);
        for (const x of [...edges, ...random]) {
          const a = { priceRoundId: 1n, totalOwed: 0n, creditPaused: false, reasons: 0, ...x };
          expect(Number(await s.guardian.evaluate(a)), JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v))).to.equal(
            cre.guardianReasons(a, th)
          );
        }
      }
    });

    it("evaluate() and guardianReasons() count only bad debt beyond what the owner acknowledged", async () => {
      const { pool, guardian } = await guardianOverDouble({ ...DEFAULTS, minOriginated: 0n });
      await pool.setState(AUSD(5_000), 0n, AUSD(60), AUSD(1_000));
      await guardian.acknowledgeBadDebt();
      const t0 = await now();
      for (const badDebt of [0n, AUSD(50), AUSD(60), AUSD(110), AUSD(111)]) {
        const a = { priceRoundId: 1n, price: PRICE("1"), priceUpdatedAt: t0, freeCash: AUSD(5_000), totalOwed: 0n, badDebt, totalOriginated: AUSD(1_000), observedAt: t0, creditPaused: false, reasons: 0 };
        const want = cre.guardianReasons(a, { ...DEFAULTS, minOriginated: 0n }, AUSD(60));
        expect(Number(await guardian.evaluate(a)), String(badDebt)).to.equal(want);
        expect(want, String(badDebt)).to.equal(badDebt > AUSD(110) ? BAD_DEBT : 0);
      }
    });

    it("the workflow's one read on the pool's chain returns the pool state, the thresholds and the acknowledged bad debt", async () => {
      const [state, limits, acknowledged] = await s.guardian.currentInputs();
      expect(state).to.deep.equal([AUSD(50_000), 0n, 0n, 0n]);
      expect(limits).to.deep.equal(tuple(DEFAULTS));
      expect(acknowledged).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------
  describe("who may deliver an attestation", () => {
    it("only the forwarder, and while simulating only the simulator's transmitter", async () => {
      const body = cre.encodeGuardianReport(await attestation());
      await expect(s.guardian.connect(s.stranger).onReport("0x" + "00".repeat(64), body))
        .to.be.revertedWithCustomError(s.guardian, "InvalidSender")
        .withArgs(s.stranger.address, await s.forwarder.getAddress());
      const r = await deliver(s.guardian, body, { from: s.stranger });
      expect(r.ok).to.equal(false);
      expect(s.guardian.interface.parseError(r.revert).name).to.equal("NotSimulationTransmitter");
      expect(await s.guardian.latestRound()).to.equal(0n);
      expect((await deliver(s.guardian, body)).ok).to.equal(true);
    });

    it("with the owner, name and id locked, refuses a report from any other workflow", async () => {
      const id = ethers.id("polaris-guardian build 1");
      await s.guardian.setExpectedAuthor(s.workflowOwner.address);
      await s.guardian.setExpectedWorkflowName(cre.WORKFLOW_NAMES.GUARDIAN);
      await s.guardian.setExpectedWorkflowId(id);
      const body = cre.encodeGuardianReport(await attestation());
      const cases = [
        [{ workflowId: id, workflowOwner: s.stranger.address }, "InvalidAuthor"],
        [{ workflowId: id, workflowName: cre.WORKFLOW_NAMES.COLLECTIONS }, "InvalidWorkflowName"],
        [{ workflowId: ethers.id("another build") }, "InvalidWorkflowId"],
      ];
      for (const [opts, error] of cases) {
        const r = await deliver(s.guardian, body, opts);
        expect(s.guardian.interface.parseError(r.revert).name).to.equal(error);
      }
      expect(await s.guardian.latestRound()).to.equal(0n);
      expect((await deliver(s.guardian, body, { workflowId: id })).ok).to.equal(true);
    });

    it("refuses another receiver's report, and every report with the forwarder check switched off", async () => {
      const wrong = await deliver(s.guardian, cre.encodeCollectionsReport([]));
      expect(s.guardian.interface.parseError(wrong.revert).name).to.equal("UnknownReportKind");
      expect(cre.workflowNameBytes10(cre.WORKFLOW_NAMES.GUARDIAN)).to.equal(
        ethers.hexlify(ethers.toUtf8Bytes(ethers.sha256(ethers.toUtf8Bytes("polaris-guardian")).slice(2, 12)))
      );
      await s.guardian.setForwarderAddress(ethers.ZeroAddress);
      await s.guardian.setSimulationTransmitter(ethers.ZeroAddress);
      await expect(s.guardian.connect(s.stranger).onReport("0x" + "00".repeat(64), cre.encodeGuardianReport(await attestation())))
        .to.be.revertedWithCustomError(s.guardian, "ForwarderCheckDisabled");
    });

    it("refuses construction without a pool, or with bad thresholds", async () => {
      const F = await ethers.getContractFactory("GuardianReceiver");
      await expect(F.deploy(s.forwarder, ethers.ZeroAddress, s.don.address, DEFAULTS, 3600)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(s.forwarder, s.engine, s.don.address, { ...DEFAULTS, minPrice: 0n }, 3600)).to.be.revertedWithCustomError(F, "InvalidThresholds");
      await expect(F.deploy(s.forwarder, s.engine, s.don.address, DEFAULTS, 0)).to.be.revertedWithCustomError(F, "InvalidMaxAttestationAge");
      expect(await s.guardian.cashScale()).to.equal(10n ** 6n);
    });
  });

  // ---------------------------------------------------------------------
  describe("while credit is paused, everything else keeps working", () => {
    beforeEach(async () => {
      await s.feed.setAnswer(PRICE("0.95"));
      await attest();
      expect((await s.checkout.creditPaused())[0]).to.equal(true);
    });

    it("Pay now", async () => {
      const buyer = await newBuyer();
      const orderId = "now-1";
      const auth = await signReceive(s.ausd, buyer, await s.payments.getAddress(), AUSD(25), paymentId(s.merchant.address, orderId));
      await expect(
        s.checkout.connect(s.relayer).pay(buyer.address, s.merchant.address, AUSD(25), orderId, auth.validAfter, auth.validBefore, auth.v, auth.r, auth.s)
      ).to.emit(s.checkout, "CheckoutPaid");
    });

    it("Subscribe", async () => {
      const buyer = await newBuyer();
      await s.payments.connect(s.merchant).createPlan(AUSD(10), MONTH, "Pro");
      const intent = {
        buyer: buyer.address, merchant: s.merchant.address, planId: 1n, pricePerPeriod: AUSD(10),
        periodSeconds: BigInt(MONTH), orderId: "sub-1", nonce: 0n, deadline: (await now()) + 600n,
      };
      const p = await signPermit(s.ausd, buyer, await s.payments.getAddress(), AUSD(120));
      const sig = (await signTyped(buyer, s.checkout, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent)).signature;
      await expect(s.checkout.connect(s.relayer).subscribe(intent, sig, { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s }))
        .to.emit(s.checkout, "SubscriptionStarted");
    });

    it("Send by link", async () => {
      const sender = await newBuyer();
      const linkKey = ethers.Wallet.createRandom();
      const amount = AUSD(50);
      const expiresAt = (await now()) + BigInt(WEEK);
      const auth = await signReceive(s.ausd, sender, await s.send.getAddress(), amount, await s.send.sendNonce(linkKey.address, expiresAt), {
        validBefore: (await now()) + 1_800n,
      });
      const open = ethers.Signature.from(
        await linkKey.signTypedData(
          { name: "PolarisSend", version: "1", chainId: 31337, verifyingContract: await s.send.getAddress() },
          { Open: TYPES.PolarisSend.Open },
          { sender: sender.address, amount, expiresAt }
        )
      );
      await expect(
        s.send.connect(s.relayer).send(sender.address, linkKey.address, amount, expiresAt, auth.validAfter, auth.validBefore, auth.v, auth.r, auth.s, open.v, open.r, open.s)
      ).to.not.be.reverted;
      expect(await s.ausd.balanceOf(await s.send.getAddress())).to.equal(amount);
    });

    it("plans already open are still collected, repaid and re-signed", async () => {
      // Open a plan first under a forced resume, then hand back to the pause.
      await resumeFor(s.guardian);
      const buyer = await newBuyer();
      await s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)));
      const loanId = await s.engine.loanCount();
      await s.guardian.setOverride(OVERRIDE.NONE, 0);
      await time.increase(WEEK);
      await attest(); // still depegged (and the price a week old): paused
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(DEPEG | STALE_PRICE)]);
      const { tx } = await deliver(s.collections, cre.encodeCollectionsReport([{ action: cre.ACTION.COLLECT_INSTALLMENT, id: loanId }]), {
        workflowName: cre.WORKFLOW_NAMES.COLLECTIONS,
      });
      await expect(tx).to.emit(s.collections, "TaskExecuted");
      // The buyer's approval goes (their own wallet), so there is something to re-sign.
      await s.owner.sendTransaction({ to: buyer.address, value: ethers.parseEther("1") });
      await s.ausd.connect(buyer).approve(s.engine, 0);
      const owed = await s.engine.activeDebtOf(buyer.address);
      const p = await signPermit(s.ausd, buyer, await s.engine.getAddress(), owed, (await now()) + 600n);
      await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, { value: owed, deadline: p.deadline, v: p.v, r: p.r, s: p.s }))
        .to.emit(s.checkout, "Reauthorized");
    });
  });
});
