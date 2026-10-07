/**
 * collectInstallment: the keeper's permissionless path, and repay made the
 * borrower's own.
 *
 * A permissionless repay that took an arbitrary amount let anyone pull a
 * borrower's whole standing allowance the day a plan opened. The Solana build
 * fixed the same hole by making the permissionless path take no amount. These
 * tests prove the EVM port of that fix: a stranger can collect only what the
 * schedule says is due, only once it is due, and a shortfall comes back as an
 * error the dunning ladder can act on.
 *
 * They also prove the two things that fix must not cost: a borrower who holds
 * no gas can still pay early, in part, or cure inside the grace period, through
 * a relayer carrying their signature, and a signature spends only against the
 * loan it was signed for, as it stood; and paying on time earns score at a pace
 * no dust plan, prepayment, pile of parallel plans or second engine can speed
 * up, while a weekly plan collected with any lag inside grace earns every week.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const { MAX_UINT, signTyped, signPermit } = require("../helpers/sign");

const AUSD = (n) => BigInt(Math.round(n * 1e6));
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const GRACE = 3 * DAY;
const INTERVAL = 14 * DAY;
const WEEK = 7 * DAY;
const BONUS_PERIOD = WEEK;
const MIN_SCORED_PRINCIPAL = AUSD(20);

const REPAY_TYPES = {
  RepayIntent: [
    { name: "loanId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "expectedRepaid", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const ACTIVE = 0;
const REPAID = 1;
const LIQUIDATED = 2;

/// A whole Polaris lending stack on MockAUSD. `minInterval` and `grace` are the
/// two per-deployment knobs a demo deployment turns down.
async function deploy({ minInterval = 0, grace = GRACE } = {}) {
  const [owner, borrower, merchant, stranger, keeper, other] = await ethers.getSigners();

  const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (
    await ethers.getContractFactory("PolarisLoanEngine")
  ).deploy(
    owner.address,
    await ausd.getAddress(),
    await scores.getAddress(),
    owner.address,
    grace,
    minInterval
  );

  await scores.setWriter(await engine.getAddress(), true);
  await engine.setOriginator(owner.address, true);

  await ausd.mint(owner.address, AUSD(1_000_000));
  await ausd.approve(await engine.getAddress(), AUSD(1_000_000));
  await engine.fund(AUSD(500_000));

  // A standing allowance far larger than any one plan: exactly what a stranger
  // with an arbitrary-amount repay could have drained.
  for (const who of [borrower, other]) {
    await ausd.mint(who.address, AUSD(2_000));
    await ausd.connect(who).approve(await engine.getAddress(), AUSD(2_000));
  }

  return { ausd, scores, engine, owner, borrower, merchant, stranger, keeper, other };
}

describe("collection", () => {
  let ausd, scores, engine, owner, borrower, merchant, stranger, keeper, other;

  beforeEach(async () => {
    ({ ausd, scores, engine, owner, borrower, merchant, stranger, keeper, other } = await deploy());
  });

  async function openPlan(principal = AUSD(200), count = 4, interval = INTERVAL, who = borrower) {
    await engine.createLoan(who.address, merchant.address, principal, count, interval);
    return await engine.loanCount();
  }

  describe("a stranger collecting", () => {
    it("a stranger collects exactly the instalment due and not a unit more", async () => {
      const id = await openPlan();
      const due = await engine.installmentAmount(id);
      await time.increaseTo(await engine.installmentDueAt(id, 0));

      const walletBefore = await ausd.balanceOf(borrower.address);
      const allowanceBefore = await ausd.allowance(borrower.address, await engine.getAddress());
      const poolBefore = await ausd.balanceOf(await engine.getAddress());

      expect(await engine.connect(stranger).collectInstallment.staticCall(id)).to.equal(due);
      await expect(engine.connect(stranger).collectInstallment(id))
        .to.emit(engine, "InstallmentCollected")
        .withArgs(id, stranger.address, due)
        .and.to.emit(engine, "InstallmentPaid")
        .withArgs(id, borrower.address, 0, due, true);

      expect(await ausd.balanceOf(borrower.address)).to.equal(walletBefore - due);
      expect(await ausd.allowance(borrower.address, await engine.getAddress())).to.equal(
        allowanceBefore - due
      );
      expect(await ausd.balanceOf(await engine.getAddress())).to.equal(poolBefore + due);
      expect((await engine.getLoan(id)).installmentsPaid).to.equal(1);

      // The next instalment is two weeks out, so calling again takes nothing.
      await expect(engine.connect(stranger).collectInstallment(id)).to.be.revertedWithCustomError(
        engine,
        "NotDue"
      );
      expect(await ausd.balanceOf(borrower.address)).to.equal(walletBefore - due);
    });

    it("a stranger cannot drain a standing allowance the day a plan opens", async () => {
      const id = await openPlan();
      const walletBefore = await ausd.balanceOf(borrower.address);
      const allowanceBefore = await ausd.allowance(borrower.address, await engine.getAddress());

      // The old attack: an arbitrary amount through the permissionless path.
      await expect(
        engine.connect(stranger).repay(id, allowanceBefore)
      ).to.be.revertedWithCustomError(engine, "NotBorrower");
      // And the new permissionless path has nothing to take before the schedule says so.
      await expect(engine.connect(stranger).collectInstallment(id)).to.be.revertedWithCustomError(
        engine,
        "NotDue"
      );

      expect(await ausd.balanceOf(borrower.address)).to.equal(walletBefore);
      expect(await ausd.allowance(borrower.address, await engine.getAddress())).to.equal(
        allowanceBefore
      );
    });

    it("with several instalments overdue, each call collects one instalment and no more", async () => {
      const id = await openPlan();
      // Three of four instalments have fallen due.
      await time.increaseTo(await engine.installmentDueAt(id, 2));

      for (let i = 0; i < 3; i++) {
        const due = await engine.installmentAmount(id);
        const before = await ausd.balanceOf(borrower.address);
        await engine.connect(stranger).collectInstallment(id);
        expect(await ausd.balanceOf(borrower.address)).to.equal(before - due);
        expect((await engine.getLoan(id)).installmentsPaid).to.equal(i + 1);
      }

      // The fourth is not due yet, however many times it is asked for.
      await expect(engine.connect(stranger).collectInstallment(id)).to.be.revertedWithCustomError(
        engine,
        "NotDue"
      );
      expect((await engine.getLoan(id)).status).to.equal(ACTIVE);
    });

    it("after a partial prepayment, collection draws only the shortfall", async () => {
      const id = await openPlan();
      const due = await engine.installmentAmount(id);
      const half = due / 2n;
      await engine.connect(borrower).repay(id, half);

      await time.increaseTo(await engine.installmentDueAt(id, 0));
      await expect(engine.connect(stranger).collectInstallment(id))
        .to.emit(engine, "InstallmentCollected")
        .withArgs(id, stranger.address, due - half);

      const loan = await engine.getLoan(id);
      expect(loan.totalRepaid).to.equal(due);
      expect(loan.installmentsPaid).to.equal(1);
    });

    it("an instalment the borrower prepaid is not collected again when its date arrives", async () => {
      const id = await openPlan();
      await engine.connect(borrower).repay(id, await engine.installmentAmount(id));

      // Instalment 0's date: nothing is due, because instalment 0 is paid.
      await time.increaseTo(await engine.installmentDueAt(id, 0));
      await expect(engine.connect(stranger).collectInstallment(id)).to.be.revertedWithCustomError(
        engine,
        "NotDue"
      );

      // Instalment 1's date: now there is.
      await time.increaseTo(await engine.installmentDueAt(id, 1));
      await expect(engine.connect(stranger).collectInstallment(id))
        .to.emit(engine, "InstallmentPaid")
        .withArgs(id, borrower.address, 1, anyValue, true);
    });
  });

  describe("timing", () => {
    it("an instalment cannot be collected before it falls due", async () => {
      const id = await openPlan();
      const dueAt = await engine.installmentDueAt(id, 0);

      await time.setNextBlockTimestamp(dueAt - 1n);
      await expect(engine.connect(stranger).collectInstallment(id)).to.be.revertedWithCustomError(
        engine,
        "NotDue"
      );

      // The due timestamp itself is collectable, matching isInstallmentDue.
      await time.setNextBlockTimestamp(dueAt);
      await expect(engine.connect(stranger).collectInstallment(id)).to.not.be.reverted;
    });

    it("a late collection scores late and an on-time one on time", async () => {
      const id = await openPlan();
      const start = await scores.scoreOf(borrower.address);
      const bonus = await scores.ON_TIME_BONUS();
      const penalty = await scores.LATE_PENALTY();

      // Instalment 0 on the last second of its grace period: still on time,
      // the same instant liquidation is still refused.
      await time.setNextBlockTimestamp((await engine.installmentDueAt(id, 0)) + BigInt(GRACE));
      await expect(engine.connect(keeper).collectInstallment(id))
        .to.emit(engine, "InstallmentPaid")
        .withArgs(id, borrower.address, 0, anyValue, true)
        .and.to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, start, start + bonus, "on-time payment");

      // Instalment 1 one second after its grace period: late. The loan is
      // liquidatable at that moment, and the keeper's collection rescues it.
      const lateAt = (await engine.installmentDueAt(id, 1)) + BigInt(GRACE) + 1n;
      await time.increaseTo(lateAt);
      expect(await engine.checkLiquidatable(id)).to.equal(true);

      await expect(engine.connect(keeper).collectInstallment(id))
        .to.emit(engine, "InstallmentPaid")
        .withArgs(id, borrower.address, 1, anyValue, false)
        .and.to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, start + bonus, start + bonus - penalty, "late payment");

      expect(await engine.checkLiquidatable(id)).to.equal(false);
      const profile = await scores.profileOf(borrower.address);
      expect(profile.onTimePayments).to.equal(1);
      expect(profile.latePayments).to.equal(1);
    });
  });

  describe("shortfalls the dunning ladder can act on", () => {
    let id, due;

    beforeEach(async () => {
      id = await openPlan();
      due = await engine.installmentAmount(id);
      await time.increaseTo(await engine.installmentDueAt(id, 0));
    });

    it("a revoked allowance is reported as allowance lost (InsufficientAllowance) and a short balance as short on funds (InsufficientBalance)", async () => {
      const engineAddr = await engine.getAddress();

      // Allowance lost: revoked outright, then cut to one unit short.
      await ausd.connect(borrower).approve(engineAddr, 0);
      await expect(engine.connect(keeper).collectInstallment(id))
        .to.be.revertedWithCustomError(engine, "InsufficientAllowance")
        .withArgs(0n, due);

      await ausd.connect(borrower).approve(engineAddr, due - 1n);
      await expect(engine.connect(keeper).collectInstallment(id))
        .to.be.revertedWithCustomError(engine, "InsufficientAllowance")
        .withArgs(due - 1n, due);

      // Short on funds: the allowance is back, the wallet is one unit short.
      await ausd.connect(borrower).approve(engineAddr, AUSD(2_000));
      const balance = await ausd.balanceOf(borrower.address);
      await ausd.connect(borrower).transfer(owner.address, balance - (due - 1n));
      await expect(engine.connect(keeper).collectInstallment(id))
        .to.be.revertedWithCustomError(engine, "InsufficientBalance")
        .withArgs(due - 1n, due);

      // Topped up, the same call succeeds.
      await ausd.mint(borrower.address, 1n);
      await expect(engine.connect(keeper).collectInstallment(id))
        .to.emit(engine, "InstallmentCollected")
        .withArgs(id, keeper.address, due);
    });

    it("reports allowance lost first when both are short, since no balance is reachable without it", async () => {
      await ausd.connect(borrower).approve(await engine.getAddress(), 0);
      await ausd
        .connect(borrower)
        .transfer(owner.address, await ausd.balanceOf(borrower.address));

      await expect(engine.connect(keeper).collectInstallment(id))
        .to.be.revertedWithCustomError(engine, "InsufficientAllowance")
        .withArgs(0n, due);
    });
  });

  describe("the whole plan", () => {
    it("collecting every instalment closes the loan at exactly what is owed, with the protocol fee never above the interest earned", async () => {
      // Seven instalments on an odd principal, so the total rarely divides evenly.
      const id = await openPlan(AUSD(333.33), 7, 10 * DAY);
      const loan = await engine.getLoan(id);
      const interest = loan.totalOwed - loan.principal;
      const walletBefore = await ausd.balanceOf(borrower.address);
      const poolBefore = await ausd.balanceOf(await engine.getAddress());

      let collected = 0n;
      for (let i = 0; i < 7; i++) {
        await time.increaseTo(await engine.installmentDueAt(id, i));
        const due = await engine.installmentAmount(id);
        expect(due).to.be.greaterThan(0n);
        const tx = engine.connect(stranger).collectInstallment(id);
        if (i === 6) {
          await expect(tx).to.emit(engine, "LoanFullyRepaid").withArgs(id, borrower.address);
        } else {
          await tx;
        }
        collected += due;
      }

      expect(collected).to.equal(loan.totalOwed);
      expect(walletBefore - (await ausd.balanceOf(borrower.address))).to.equal(loan.totalOwed);
      expect(await ausd.balanceOf(await engine.getAddress())).to.equal(poolBefore + loan.totalOwed);
      expect(await engine.outstandingOf(id)).to.equal(0n);
      expect(await engine.activeDebtOf(borrower.address)).to.equal(0n);
      expect((await engine.getLoan(id)).status).to.equal(REPAID);
      expect((await engine.getLoan(id)).installmentsPaid).to.equal(7);

      const fees = await engine.protocolFeesAccrued();
      expect(fees).to.be.greaterThan(0n);
      expect(fees).to.be.lessThanOrEqual(interest);
    });

    it("a keeper's collection is booked exactly like the borrower's own payment, and only the collection says so", async () => {
      // Two identical plans opened in the same block, so their schedules match.
      await ethers.provider.send("evm_setAutomine", [false]);
      await engine.createLoan(borrower.address, merchant.address, AUSD(200), 4, INTERVAL);
      await engine.createLoan(other.address, merchant.address, AUSD(200), 4, INTERVAL);
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);
      const [paidId, collectedId] = [1n, 2n];
      expect(await engine.installmentDueAt(paidId, 0)).to.equal(
        await engine.installmentDueAt(collectedId, 0)
      );

      await time.increaseTo(await engine.installmentDueAt(paidId, 0));
      const due = await engine.installmentAmount(paidId);

      const feesBefore = await engine.protocolFeesAccrued();
      const paidTx = await engine.connect(borrower).repay(paidId, due);
      const feeOnPayment = (await engine.protocolFeesAccrued()) - feesBefore;
      const collectedTx = await engine.connect(keeper).collectInstallment(collectedId);
      const feeOnCollection = (await engine.protocolFeesAccrued()) - feesBefore - feeOnPayment;

      const [a, b] = [await engine.getLoan(paidId), await engine.getLoan(collectedId)];
      expect(b.totalRepaid).to.equal(a.totalRepaid);
      expect(b.installmentsPaid).to.equal(a.installmentsPaid);
      expect(b.status).to.equal(a.status);
      expect(feeOnCollection).to.equal(feeOnPayment);
      expect(await scores.scoreOf(other.address)).to.equal(await scores.scoreOf(borrower.address));

      const collectedEvents = async (tx) =>
        (await tx.wait()).logs.filter(
          (log) => log.fragment && log.fragment.name === "InstallmentCollected"
        ).length;
      expect(await collectedEvents(paidTx)).to.equal(0);
      expect(await collectedEvents(collectedTx)).to.equal(1);
    });
  });

  describe("who may pay what", () => {
    it("a stranger's repay reverts NotBorrower while the borrower can still prepay", async () => {
      const id = await openPlan();
      const owed = (await engine.getLoan(id)).totalOwed;

      for (const caller of [stranger, keeper, owner, merchant]) {
        await expect(engine.connect(caller).repay(id, 1n)).to.be.revertedWithCustomError(
          engine,
          "NotBorrower"
        );
      }

      // The borrower pays the whole plan off the day it opens.
      const before = await ausd.balanceOf(borrower.address);
      await expect(engine.connect(borrower).repay(id, owed))
        .to.emit(engine, "LoanFullyRepaid")
        .withArgs(id, borrower.address);
      expect(await ausd.balanceOf(borrower.address)).to.equal(before - owed);
      expect((await engine.getLoan(id)).status).to.equal(REPAID);
    });

    it("collectInstallment on a repaid or liquidated loan reverts", async () => {
      const repaidId = await openPlan();
      await engine.connect(borrower).repay(repaidId, (await engine.getLoan(repaidId)).totalOwed);

      const liquidatedId = await openPlan(AUSD(100), 4, INTERVAL, other);
      await time.increaseTo((await engine.installmentDueAt(liquidatedId, 0)) + BigInt(GRACE) + 1n);
      await engine.connect(keeper).liquidate(liquidatedId);
      expect((await engine.getLoan(liquidatedId)).status).to.equal(LIQUIDATED);

      // Both are well past their first due date, so only the status can refuse.
      for (const id of [repaidId, liquidatedId]) {
        await expect(engine.connect(stranger).collectInstallment(id)).to.be.revertedWithCustomError(
          engine,
          "LoanNotActive"
        );
      }
      await expect(engine.connect(stranger).collectInstallment(999)).to.be.revertedWithCustomError(
        engine,
        "InvalidLoan"
      );
    });
  });

  describe("the per-deployment minimum interval", () => {
    it("a one-minute demo deployment (minInterval = 60) runs a whole plan while a default deployment refuses a one-minute interval", async () => {
      // The default deployment, from beforeEach, keeps the one-hour floor.
      expect(await engine.minInterval()).to.equal(60n * 60n);
      await expect(
        engine.createLoan(borrower.address, merchant.address, AUSD(100), 4, 60)
      ).to.be.revertedWithCustomError(engine, "InvalidInterval");

      const demo = await deploy({ minInterval: 60, grace: 60 });
      expect(await demo.engine.minInterval()).to.equal(60n);
      // Even the demo refuses anything under a minute.
      await expect(
        demo.engine.createLoan(demo.borrower.address, demo.merchant.address, AUSD(100), 4, 59)
      ).to.be.revertedWithCustomError(demo.engine, "InvalidInterval");

      await demo.engine.createLoan(demo.borrower.address, demo.merchant.address, AUSD(100), 4, 60);
      const id = await demo.engine.loanCount();
      const loan = await demo.engine.getLoan(id);

      for (let i = 0; i < 4; i++) {
        await time.increaseTo(await demo.engine.installmentDueAt(id, i));
        await expect(demo.engine.connect(demo.keeper).collectInstallment(id))
          .to.emit(demo.engine, "InstallmentPaid")
          .withArgs(id, demo.borrower.address, i, anyValue, true);
      }

      const closed = await demo.engine.getLoan(id);
      expect(closed.status).to.equal(REPAID);
      expect(closed.totalRepaid).to.equal(loan.totalOwed);
      // Four minutes and a few blocks, start to finish.
      expect(BigInt(await time.latest()) - loan.startedAt).to.be.lessThan(5n * 60n);
    });
  });

  describe("what paying on time earns", () => {
    it("a plan one unit under MIN_SCORED_PRINCIPAL earns no bonus, and one at it does", async () => {
      expect(await engine.MIN_SCORED_PRINCIPAL()).to.equal(MIN_SCORED_PRINCIPAL);

      const small = await openPlan(MIN_SCORED_PRINCIPAL - 1n, 4, INTERVAL, borrower);
      const tx = engine.connect(borrower).repay(small, await engine.installmentAmount(small));
      await expect(tx).to.emit(engine, "OnTimeBonusWithheld").withArgs(small, borrower.address);
      await expect(tx).not.to.emit(scores, "ScoreChanged");
      // Earning nothing, it leaves no record behind either.
      expect((await scores.profileOf(borrower.address)).initialized).to.equal(false);

      const real = await openPlan(MIN_SCORED_PRINCIPAL, 4, INTERVAL, other);
      await expect(engine.connect(other).repay(real, await engine.installmentAmount(real)))
        .to.emit(scores, "ScoreChanged")
        .withArgs(other.address, 600, 612, "on-time payment");
    });

    it("prepaying a plan one instalment at a time earns one bonus, not one per instalment", async () => {
      // The farming shape: 24 hourly instalments, each completed by its own call.
      const id = await openPlan(AUSD(240), 24, HOUR);
      let withheld = 0;
      for (let i = 0; i < 24; i++) {
        const receipt = await (
          await engine.connect(borrower).repay(id, await engine.installmentAmount(id))
        ).wait();
        withheld += receipt.logs.filter(
          (log) => log.fragment && log.fragment.name === "OnTimeBonusWithheld"
        ).length;
      }

      expect((await engine.getLoan(id)).status).to.equal(REPAID);
      expect(withheld).to.equal(23);
      const p = await scores.profileOf(borrower.address);
      expect(p.score).to.equal(612);
      // Every instalment was on time and is counted; only one moved the score.
      expect(p.onTimePayments).to.equal(24);
    });

    it("twenty plans paid at once earn one bonus: the score rises at most once per BONUS_PERIOD", async () => {
      expect(await scores.BONUS_PERIOD()).to.equal(BigInt(BONUS_PERIOD));

      // Parallel plans are what defeats any per-instalment rule: twenty real
      // plans, each one instalment, all paid in the same hour.
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push(await openPlan(MIN_SCORED_PRINCIPAL, 1, HOUR));
      for (const id of ids) {
        await engine.connect(borrower).repay(id, await engine.installmentAmount(id));
      }
      expect(await scores.scoreOf(borrower.address)).to.equal(612);
      const earnedAt = await scores.lastBonusAt(borrower.address);
      expect(earnedAt).to.be.greaterThan(0n);

      // One second short of a week: still withheld.
      const next = await openPlan(MIN_SCORED_PRINCIPAL, 2, INTERVAL);
      await time.setNextBlockTimestamp(earnedAt + BigInt(BONUS_PERIOD) - 1n);
      await expect(engine.connect(borrower).repay(next, await engine.installmentAmount(next)))
        .to.emit(engine, "OnTimeBonusWithheld")
        .withArgs(next, borrower.address);
      expect(await scores.scoreOf(borrower.address)).to.equal(612);

      // A week to the second: the next one counts.
      await time.setNextBlockTimestamp(earnedAt + BigInt(BONUS_PERIOD));
      await expect(engine.connect(borrower).repay(next, await engine.installmentAmount(next)))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 612, 624, "on-time payment");
      expect(await scores.lastBonusAt(borrower.address)).to.equal(earnedAt + BigInt(BONUS_PERIOD));
    });

    it("a late instalment costs on any plan, however small", async () => {
      // Trust is fast to lose: the scoring floor and the weekly ration only
      // ever withhold a bonus, never a penalty.
      const dust = await openPlan(2n, 1, HOUR);
      await time.increaseTo((await engine.installmentDueAt(dust, 0)) + BigInt(GRACE) + 1n);
      await expect(engine.connect(keeper).collectInstallment(dust))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 600, 560, "late payment");

      // Nor does a recent bonus shield the next late one.
      const real = await openPlan(AUSD(100), 2, INTERVAL);
      await engine.connect(borrower).repay(real, await engine.installmentAmount(real));
      expect(await scores.scoreOf(borrower.address)).to.equal(572);
      await time.increaseTo((await engine.installmentDueAt(real, 1)) + BigInt(GRACE) + 1n);
      await expect(engine.connect(keeper).collectInstallment(real))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 572, 532, "late payment");
    });

    it("a Pay in 4 on a two-week schedule still earns on every instalment", async () => {
      // Instalments a fortnight apart are always more than a BONUS_PERIOD apart.
      const id = await openPlan();
      for (let i = 0; i < 4; i++) {
        await time.increaseTo(await engine.installmentDueAt(id, i));
        await expect(engine.connect(keeper).collectInstallment(id))
          .to.emit(scores, "ScoreChanged")
          .withArgs(borrower.address, 600 + 12 * i, 612 + 12 * i, "on-time payment");
      }
      const p = await scores.profileOf(borrower.address);
      expect(p.score).to.equal(648);
      expect(p.onTimePayments).to.equal(4);
    });

    it("a weekly Pay in 4 collected on time earns all four bonuses, whatever the keeper's lag", async () => {
      // Seconds after each due date the keeper lands. The product's plan is
      // weekly, so its instalments fall due exactly a BONUS_PERIOD apart. These
      // are the orderings that used to withhold bonuses: each collection a
      // second sooner after its due date than the last; ordinary cron jitter;
      // and a griefer who collects every other instalment on its due second.
      const schedules = [
        [20, 19, 18, 17],
        [90, 30, 45, 10],
        [60, 0, 60, 0],
        [10, 30, 45, 90],
      ];
      for (const lags of schedules) {
        const s = await deploy();
        await s.engine.createLoan(s.borrower.address, s.merchant.address, AUSD(200), 4, WEEK);
        const id = await s.engine.loanCount();
        for (let i = 0; i < 4; i++) {
          await time.setNextBlockTimestamp((await s.engine.installmentDueAt(id, i)) + BigInt(lags[i]));
          const tx = s.engine.connect(s.keeper).collectInstallment(id);
          await expect(tx)
            .to.emit(s.engine, "InstallmentPaid")
            .withArgs(id, s.borrower.address, i, anyValue, true);
          await expect(tx).not.to.emit(s.engine, "OnTimeBonusWithheld");
        }
        const p = await s.scores.profileOf(s.borrower.address);
        expect(p.score, `lags ${lags}`).to.equal(648);
        expect(p.onTimePayments).to.equal(4);
      }
    });

    it("a weekly borrower short on the due date and collected inside grace still earns the next instalment on its due second", async () => {
      const id = await openPlan(AUSD(200), 4, WEEK);

      // Instalment 0: short on the day, so the keeper's first try fails.
      const held = await ausd.balanceOf(borrower.address);
      await ausd.connect(borrower).transfer(owner.address, held);
      await time.setNextBlockTimestamp(await engine.installmentDueAt(id, 0));
      await expect(engine.connect(keeper).collectInstallment(id)).to.be.revertedWithCustomError(
        engine,
        "InsufficientBalance"
      );

      // Topped up and retried a day into grace: on time, and it earns.
      await ausd.mint(borrower.address, AUSD(1_000));
      await time.setNextBlockTimestamp((await engine.installmentDueAt(id, 0)) + BigInt(DAY));
      await expect(engine.connect(keeper).collectInstallment(id))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 600, 612, "on-time payment");

      // The rest on their due seconds, six days after that retry on the clock.
      for (let i = 1; i < 4; i++) {
        await time.setNextBlockTimestamp(await engine.installmentDueAt(id, i));
        await expect(engine.connect(keeper).collectInstallment(id))
          .to.emit(scores, "ScoreChanged")
          .withArgs(borrower.address, 600 + 12 * i, 612 + 12 * i, "on-time payment");
      }
      const p = await scores.profileOf(borrower.address);
      expect(p.score).to.equal(648);
      expect(p.onTimePayments).to.equal(4);
      expect(p.latePayments).to.equal(0);
    });

    it("collecting late in grace cannot run the weekly ration ahead", async () => {
      const id = await openPlan(AUSD(200), 4, WEEK);
      const [due0, due1] = [
        await engine.installmentDueAt(id, 0),
        await engine.installmentDueAt(id, 1),
      ];

      // Instalment 0 on the last second of grace, instalment 1 on its due
      // second: four days apart on the clock, a week apart on the schedule.
      await time.setNextBlockTimestamp(due0 + BigInt(GRACE));
      await engine.connect(keeper).collectInstallment(id);
      await time.setNextBlockTimestamp(due1);
      await engine.connect(keeper).collectInstallment(id);
      expect(await scores.scoreOf(borrower.address)).to.equal(624);
      expect(await scores.lastBonusAt(borrower.address)).to.equal(due1);

      // The next bonus still counts from a week after instalment 1's due date,
      // however it is paid: a prepaid side plan one second short earns nothing.
      const side = await openPlan(AUSD(40), 2, INTERVAL);
      await time.setNextBlockTimestamp(due1 + BigInt(WEEK) - 1n);
      await expect(engine.connect(borrower).repay(side, await engine.installmentAmount(side)))
        .to.emit(engine, "OnTimeBonusWithheld")
        .withArgs(side, borrower.address);
      await time.setNextBlockTimestamp(due1 + BigInt(WEEK));
      await expect(engine.connect(borrower).repay(side, await engine.installmentAmount(side)))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 624, 636, "on-time payment");
    });

    it("an early payment counts from the moment it lands: inside a week of the last bonus it earns nothing, a week on it does", async () => {
      // The rule for paying early, and its one cost. Counting a prepaid
      // instalment from its due date would let a farmer, who picks its own
      // due dates, take a bonus straight after the last one.
      const id = await openPlan(AUSD(200), 4, INTERVAL);
      const due0 = await engine.installmentDueAt(id, 0);
      await time.setNextBlockTimestamp(due0);
      await engine.connect(keeper).collectInstallment(id);
      expect(await scores.scoreOf(borrower.address)).to.equal(612);

      // Instalment 1 falls due in two weeks; paid six days after instalment 0.
      await time.setNextBlockTimestamp(due0 + BigInt(6 * DAY));
      await expect(engine.connect(borrower).repay(id, await engine.installmentAmount(id)))
        .to.emit(engine, "OnTimeBonusWithheld")
        .withArgs(id, borrower.address);

      // Instalment 2, paid early too, but a week after instalment 0 counted.
      await time.setNextBlockTimestamp(due0 + BigInt(WEEK));
      await expect(engine.connect(borrower).repay(id, await engine.installmentAmount(id)))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 612, 624, "on-time payment");

      const p = await scores.profileOf(borrower.address);
      expect(p.onTimePayments).to.equal(3);
      expect(p.latePayments).to.equal(0);
    });

    it("two engines on one ScoreManager pay one weekly bonus between them, and a redeploy does not reset it", async () => {
      // A second writer: the 60-second demo engine beside production, or a
      // redeploy whose predecessor was never deregistered.
      const second = await (
        await ethers.getContractFactory("PolarisLoanEngine")
      ).deploy(
        owner.address,
        await ausd.getAddress(),
        await scores.getAddress(),
        owner.address,
        0,
        60
      );
      await scores.setWriter(await second.getAddress(), true);
      await second.setOriginator(owner.address, true);
      await ausd.approve(await second.getAddress(), AUSD(1_000));
      await second.fund(AUSD(1_000));
      await ausd.connect(borrower).approve(await second.getAddress(), AUSD(1_000));

      const farm = async (e) => {
        await e.createLoan(borrower.address, merchant.address, MIN_SCORED_PRINCIPAL, 1, HOUR);
        const id = await e.loanCount();
        return e.connect(borrower).repay(id, await e.outstandingOf(id));
      };

      await expect(farm(engine))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 600, 612, "on-time payment");
      await expect(farm(second)).to.emit(second, "OnTimeBonusWithheld");
      expect(await scores.scoreOf(borrower.address)).to.equal(612);

      // The clock is the score's, not the engine's: a week on, one of them earns.
      await time.increase(BONUS_PERIOD);
      await expect(farm(second))
        .to.emit(scores, "ScoreChanged")
        .withArgs(borrower.address, 612, 624, "on-time payment");
      await expect(farm(engine)).to.emit(engine, "OnTimeBonusWithheld");
      expect(await scores.scoreOf(borrower.address)).to.equal(624);
    });
  });

  describe("a borrower who holds no gas", () => {
    let wallet;

    /// A Mera-style account: an EOA that never holds MON. Its allowance comes
    /// from a relayed ERC-2612 permit, exactly as PolarisCheckout will do it.
    beforeEach(async () => {
      wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      await ausd.mint(wallet.address, AUSD(2_000));
      const engineAddr = await engine.getAddress();
      const p = await signPermit(ausd, wallet, engineAddr, AUSD(2_000));
      await ausd
        .connect(stranger)
        .permit(wallet.address, engineAddr, p.value, p.deadline, p.v, p.r, p.s);
      expect(await ethers.provider.getBalance(wallet.address)).to.equal(0n);
    });

    /// What the borrower's wallet signs: this loan, this amount, against the
    /// loan as it stands now. Returns the signature and the state it binds.
    async function signRepay(signer, loanId, amount, { deadline = MAX_UINT, nonce, expectedRepaid } = {}) {
      const n = nonce ?? (await engine.nonces(signer.address));
      const repaid = expectedRepaid ?? (await engine.getLoan(loanId)).totalRepaid;
      const { signature } = await signTyped(signer, engine, REPAY_TYPES, {
        loanId,
        amount,
        expectedRepaid: repaid,
        nonce: n,
        deadline,
      });
      return { sig: signature, repaid };
    }

    /// Sign and relay in one step, the happy path.
    async function relayRepay(relayer, signer, loanId, amount) {
      const { sig, repaid } = await signRepay(signer, loanId, amount);
      return engine.connect(relayer).repayWithSig(loanId, amount, repaid, MAX_UINT, sig);
    }

    it("a gasless borrower prepays through a relayer with a signed RepayIntent", async () => {
      const id = await openPlan(AUSD(200), 4, INTERVAL, wallet);
      const due = await engine.installmentAmount(id);
      const before = await ausd.balanceOf(wallet.address);

      const tx = relayRepay(keeper, wallet, id, due);
      await expect(tx)
        .to.emit(engine, "InstallmentPaid")
        .withArgs(id, wallet.address, 0, due, true)
        .and.to.emit(scores, "ScoreChanged")
        .withArgs(wallet.address, 600, 612, "on-time payment");
      // It is the borrower's own payment, not a keeper's collection.
      await expect(tx).not.to.emit(engine, "InstallmentCollected");

      expect(await ausd.balanceOf(wallet.address)).to.equal(before - due);
      expect((await engine.getLoan(id)).installmentsPaid).to.equal(1);
      expect(await engine.nonces(wallet.address)).to.equal(1n);
      expect(await ethers.provider.getBalance(wallet.address)).to.equal(0n);

      // And pays the rest off early the same way.
      await expect(relayRepay(keeper, wallet, id, await engine.outstandingOf(id)))
        .to.emit(engine, "LoanFullyRepaid")
        .withArgs(id, wallet.address);
    });

    it("a relayer cannot redirect a signed repayment to another loan, or change its amount", async () => {
      const first = await openPlan(AUSD(200), 4, INTERVAL, wallet);
      const second = await openPlan(AUSD(100), 4, INTERVAL, wallet);
      const theirs = await openPlan(AUSD(100), 4, INTERVAL, other);
      const due = await engine.installmentAmount(first);
      const { sig, repaid } = await signRepay(wallet, first, due);
      expect(repaid).to.equal(0n);

      for (const [loanId, amount, expected, deadline] of [
        [second, due, 0n, MAX_UINT], // another of the borrower's loans
        [theirs, due, 0n, MAX_UINT], // somebody else's loan
        [first, due + 1n, 0n, MAX_UINT], // more than was signed
        [first, due - 1n, 0n, MAX_UINT], // less than was signed
        [first, due, 1n, MAX_UINT], // a loan state the borrower never saw
        [first, due, 0n, MAX_UINT - 1n], // a different deadline
      ]) {
        await expect(
          engine.connect(keeper).repayWithSig(loanId, amount, expected, deadline, sig)
        ).to.be.revertedWithCustomError(engine, "InvalidSignature");
      }

      const untouched = await ausd.balanceOf(wallet.address);
      await engine.connect(keeper).repayWithSig(first, due, repaid, MAX_UINT, sig);
      expect(await ausd.balanceOf(wallet.address)).to.equal(untouched - due);
      expect((await engine.getLoan(second)).totalRepaid).to.equal(0n);
      expect((await engine.getLoan(theirs)).totalRepaid).to.equal(0n);
    });

    it("a signed repayment cannot be replayed", async () => {
      const id = await openPlan(AUSD(200), 4, INTERVAL, wallet);
      const amount = AUSD(10);
      const { sig, repaid } = await signRepay(wallet, id, amount);

      await engine.connect(keeper).repayWithSig(id, amount, repaid, MAX_UINT, sig);
      const after = await ausd.balanceOf(wallet.address);

      for (const relayer of [keeper, stranger]) {
        await expect(
          engine.connect(relayer).repayWithSig(id, amount, repaid, MAX_UINT, sig)
        ).to.be.revertedWithCustomError(engine, "InvalidSignature");
      }
      expect(await ausd.balanceOf(wallet.address)).to.equal(after);
      expect((await engine.getLoan(id)).totalRepaid).to.equal(amount);
    });

    it("an expired RepayIntent is refused", async () => {
      const id = await openPlan(AUSD(200), 4, INTERVAL, wallet);
      const amount = AUSD(10);
      const deadline = BigInt(await time.latest()) + 100n;
      const { sig } = await signRepay(wallet, id, amount, { deadline });

      await time.setNextBlockTimestamp(deadline + 1n);
      await expect(
        engine.connect(keeper).repayWithSig(id, amount, 0n, deadline, sig)
      ).to.be.revertedWithCustomError(engine, "SignatureExpired");

      // Signed afresh, it lands on its deadline's own second.
      const later = deadline + 200n;
      const fresh = await signRepay(wallet, id, amount, { deadline: later });
      await time.setNextBlockTimestamp(later);
      await expect(engine.connect(keeper).repayWithSig(id, amount, 0n, later, fresh.sig)).to.not.be
        .reverted;
    });

    it("nobody but the borrower can sign a repayment of their loan", async () => {
      const id = await openPlan(AUSD(200), 4, INTERVAL, wallet);
      const due = await engine.installmentAmount(id);
      const before = await ausd.balanceOf(wallet.address);

      // A stranger's signature, the relayer's own, and bytes that are no
      // signature at all: each is refused with the same typed error.
      for (const signer of [stranger, keeper]) {
        const forged = await signRepay(signer, id, due, { nonce: await engine.nonces(wallet.address) });
        await expect(
          engine.connect(keeper).repayWithSig(id, due, 0n, MAX_UINT, forged.sig)
        ).to.be.revertedWithCustomError(engine, "InvalidSignature");
      }
      for (const junk of ["0x", "0x1234", "0x" + "00".repeat(65)]) {
        await expect(
          engine.connect(keeper).repayWithSig(id, due, 0n, MAX_UINT, junk)
        ).to.be.revertedWithCustomError(engine, "InvalidSignature");
      }
      await expect(
        engine.connect(keeper).repayWithSig(999, due, 0n, MAX_UINT, "0x")
      ).to.be.revertedWithCustomError(engine, "InvalidLoan");

      expect(await ausd.balanceOf(wallet.address)).to.equal(before);
    });

    it("a gasless borrower cures a missed instalment inside the grace period, so nobody can liquidate them", async () => {
      const id = await openPlan(AUSD(200), 4, INTERVAL, wallet);
      // Nobody collected on the due date, and the grace clock is running.
      await time.increaseTo((await engine.installmentDueAt(id, 0)) + BigInt(DAY));
      const due = await engine.installmentAmount(id);

      await expect(relayRepay(stranger, wallet, id, due))
        .to.emit(engine, "InstallmentPaid")
        .withArgs(id, wallet.address, 0, due, true);

      // The moment the grace period ends, there is nothing to liquidate.
      await time.increaseTo((await engine.installmentDueAt(id, 0)) + BigInt(GRACE) + 1n);
      expect(await engine.checkLiquidatable(id)).to.equal(false);
      await expect(engine.connect(keeper).liquidate(id)).to.be.revertedWithCustomError(
        engine,
        "NotLiquidatable"
      );
      expect(await scores.scoreOf(wallet.address)).to.equal(612);
    });

    it("a gasless borrower pays the part of an instalment they can afford, and collection takes only the shortfall", async () => {
      const id = await openPlan(AUSD(200), 4, INTERVAL, wallet);
      const due = await engine.installmentAmount(id);
      const partial = (due * 76n) / 100n;

      // What the dunning ladder's "collect partial" needs: the borrower's
      // consent to an amount, carried by a relayer.
      await relayRepay(keeper, wallet, id, partial);
      const loan = await engine.getLoan(id);
      expect(loan.totalRepaid).to.equal(partial);
      expect(loan.installmentsPaid).to.equal(0);

      await time.increaseTo(await engine.installmentDueAt(id, 0));
      await expect(engine.connect(keeper).collectInstallment(id))
        .to.emit(engine, "InstallmentCollected")
        .withArgs(id, keeper.address, due - partial);
      expect((await engine.getLoan(id)).installmentsPaid).to.equal(1);
    });

    it("a signed cure cannot land after the keeper's retry collected the same instalment, drawing a second one early", async () => {
      const id = await openPlan(AUSD(200), 4, WEEK, wallet);
      await time.increaseTo((await engine.installmentDueAt(id, 0)) + 60n);
      const due = await engine.installmentAmount(id);

      // The borrower tops up and signs a cure for the overdue instalment; the
      // keeper's scheduled retry lands first.
      const cure = await signRepay(wallet, id, due);
      const before = await ausd.balanceOf(wallet.address);
      await engine.connect(keeper).collectInstallment(id);

      // The cure was for instalment 0, which is paid. It does not become a
      // prepayment of instalment 1.
      await expect(engine.connect(stranger).repayWithSig(id, due, cure.repaid, MAX_UINT, cure.sig))
        .to.be.revertedWithCustomError(engine, "StaleIntent")
        .withArgs(due, 0n);

      expect(before - (await ausd.balanceOf(wallet.address))).to.equal(due);
      const loan = await engine.getLoan(id);
      expect(loan.installmentsPaid).to.equal(1);
      expect(loan.totalRepaid).to.equal(due);
    });

    it("a signed repayment the borrower has since covered by paying directly cannot be spent", async () => {
      // A borrower with gas this time, so they can pay directly too.
      const id = await openPlan(AUSD(200), 4, INTERVAL, borrower);
      const due = await engine.installmentAmount(id);
      const held = await signRepay(borrower, id, due);

      // They change their mind about the relayer and pay the same amount themselves.
      await engine.connect(borrower).repay(id, due);
      const after = await ausd.balanceOf(borrower.address);

      // The relayer that held the intent back cannot draw it a second time.
      await expect(engine.connect(keeper).repayWithSig(id, due, held.repaid, MAX_UINT, held.sig))
        .to.be.revertedWithCustomError(engine, "StaleIntent")
        .withArgs(due, 0n);
      expect(await ausd.balanceOf(borrower.address)).to.equal(after);
      expect((await engine.getLoan(id)).totalRepaid).to.equal(due);
    });

    it("a borrower can cancel a signed repayment without paying it", async () => {
      const id = await openPlan(AUSD(200), 4, INTERVAL, borrower);
      const due = await engine.installmentAmount(id);
      const held = await signRepay(borrower, id, due);

      await expect(engine.connect(borrower).invalidateNonce())
        .to.emit(engine, "NonceInvalidated")
        .withArgs(borrower.address, 0n);
      expect(await engine.nonces(borrower.address)).to.equal(1n);

      const before = await ausd.balanceOf(borrower.address);
      await expect(
        engine.connect(keeper).repayWithSig(id, due, held.repaid, MAX_UINT, held.sig)
      ).to.be.revertedWithCustomError(engine, "InvalidSignature");
      expect(await ausd.balanceOf(borrower.address)).to.equal(before);

      // A stranger cancelling their own nonce touches nobody else's.
      await engine.connect(stranger).invalidateNonce();
      expect(await engine.nonces(borrower.address)).to.equal(1n);
    });
  });
});
