/**
 * The instalment ladder, the liquidation boundary, and the standing allowance.
 *
 * These are the three places where an off-by-one costs real money: a ladder
 * that does not sum to the debt leaves dust owing forever, a boundary read the
 * wrong way liquidates a borrower who is still inside their grace period, and a
 * missing allowance turns an origination into an unsecured gift.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const DAY = 24 * 60 * 60;
const GRACE = 3 * DAY;

/// The ceiling division the contract's ladder is specified in terms of.
const ceilDiv = (a, b) => (a + b - 1n) / b;

/// The engine's own annualised-interest formula, so a test can size an
/// allowance to the penny before any loan exists on chain.
const owedFor = (principal, count, intervalSeconds) => {
  const term = BigInt(count) * BigInt(intervalSeconds);
  const interest = (principal * 1000n * term) / (10_000n * 365n * 86_400n);
  return principal + interest;
};

describe("PolarisLoanEngine ladder and boundaries", () => {
  let usdc, scores, engine, owner, borrower, merchant, keeper, signers, nextSigner;

  beforeEach(async () => {
    signers = await ethers.getSigners();
    [owner, borrower, merchant, keeper] = signers;
    // Indices 0-3 are the fixed cast; everything after is a disposable wallet.
    nextSigner = 4;

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    engine = await (
      await ethers.getContractFactory("PolarisLoanEngine")
    ).deploy(
      owner.address,
      await usdc.getAddress(),
      await scores.getAddress(),
      owner.address,
      GRACE,
    0
    );

    await scores.setWriter(await engine.getAddress(), true);
    await engine.setOriginator(owner.address, true);

    await usdc.approve(await engine.getAddress(), USDC(5_000_000));
    await engine.fund(USDC(1_000_000));

    await usdc.mint(borrower.address, USDC(10_000));
    await usdc.connect(borrower).approve(await engine.getAddress(), USDC(10_000));
  });

  /// Fund and approve a fresh wallet so each ladder case starts from a clean
  /// credit limit rather than sharing one borrower's headroom.
  async function freshBorrower() {
    const w = signers[nextSigner++];
    await usdc.mint(w.address, USDC(10_000));
    await usdc.connect(w).approve(await engine.getAddress(), USDC(10_000));
    return w;
  }

  describe("the instalment ladder", () => {
    // Counts chosen so totalOwed rarely divides evenly -- an even split is the
    // case that works by accident.
    for (const count of [2, 3, 5, 7, 11, 24]) {
      it(`splits a ${count}-instalment plan with no dust and no overcharge`, async () => {
        const w = await freshBorrower();
        await engine.createLoan(w.address, merchant.address, USDC(100), count, 30 * DAY);
        const id = await engine.loanCount();
        const owed = (await engine.getLoan(id)).totalOwed;

        expect(await engine.thresholdFor(id, 0)).to.equal(0n);
        expect(await engine.thresholdFor(id, count)).to.equal(owed);

        let previous = 0n;
        for (let k = 1; k < count; k++) {
          const t = await engine.thresholdFor(id, k);
          // Rounding up is what keeps a payment from landing one unit short of
          // the threshold it was calculated to meet.
          expect(t).to.equal(ceilDiv(owed * BigInt(k), BigInt(count)));
          expect(t).to.be.greaterThan(previous);
          previous = t;
        }

        // Walking the schedule end to end must land exactly on the debt.
        let paid = 0n;
        for (let i = 0; i < count; i++) {
          const due = await engine.installmentAmount(id);
          expect(due).to.be.greaterThan(0n);
          await engine.connect(w).repay(id, due);
          paid += due;
        }
        expect(paid).to.equal(owed);
        expect(await engine.outstandingOf(id)).to.equal(0n);
        expect(await engine.installmentAmount(id)).to.equal(0n);
        expect((await engine.getLoan(id)).status).to.equal(1); // Repaid
      });
    }

    it("moves totalRepaid by exactly what the token delivered", async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
      const due = await engine.installmentAmount(1);

      expect((await engine.getLoan(1)).totalRepaid).to.equal(0n);
      await engine.connect(borrower).repay(1, due);
      expect((await engine.getLoan(1)).totalRepaid).to.equal(due);

      await engine.connect(borrower).repay(1, due);
      expect((await engine.getLoan(1)).totalRepaid).to.equal(due * 2n);
    });

    it("credits a partial payment as progress without completing an instalment", async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
      const due = await engine.installmentAmount(1);
      const half = due / 2n;

      await engine.connect(borrower).repay(1, half);

      expect((await engine.getLoan(1)).totalRepaid).to.equal(half);
      expect((await engine.getLoan(1)).installmentsPaid).to.equal(0);
      // The shortfall carries: the next draw is what is still missing.
      expect(await engine.installmentAmount(1)).to.equal(due - half);

      await engine.connect(borrower).repay(1, due - half);
      expect((await engine.getLoan(1)).installmentsPaid).to.equal(1);
    });

    it("caps an overpayment at the outstanding debt rather than taking the surplus", async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
      const owed = (await engine.getLoan(1)).totalOwed;
      const before = await usdc.balanceOf(borrower.address);

      await engine.connect(borrower).repay(1, USDC(5_000));

      expect(await usdc.balanceOf(borrower.address)).to.equal(before - owed);
      expect(await engine.outstandingOf(1)).to.equal(0n);
    });

    it("clears activeDebtOf once the loan closes, freeing the credit line", async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
      const owed = (await engine.getLoan(1)).totalOwed;
      expect(await engine.activeDebtOf(borrower.address)).to.equal(owed);

      await engine.connect(borrower).repay(1, owed);
      expect(await engine.activeDebtOf(borrower.address)).to.equal(0n);
    });
  });

  describe("repay guards", () => {
    beforeEach(async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
    });

    it("rejects a loan id that was never opened", async () => {
      await expect(engine.repay(999, USDC(1))).to.be.revertedWithCustomError(
        engine,
        "InvalidLoan"
      );
    });

    it("rejects a zero draw", async () => {
      await expect(engine.connect(borrower).repay(1, 0)).to.be.revertedWithCustomError(
        engine,
        "ZeroAmount"
      );
    });

    it("rejects a further draw once the loan is settled", async () => {
      await engine.connect(borrower).repay(1, (await engine.getLoan(1)).totalOwed);
      await expect(engine.connect(borrower).repay(1, USDC(1))).to.be.revertedWithCustomError(
        engine,
        "LoanNotActive"
      );
    });
  });

  describe("the liquidation boundary", () => {
    let dueAt;

    beforeEach(async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
      dueAt = await engine.installmentDueAt(1, 0);
    });

    it("is not due one second early", async () => {
      await time.increaseTo(dueAt - 1n);
      expect(await engine.isInstallmentDue(1)).to.equal(false);
    });

    it("is due exactly on the due timestamp", async () => {
      await time.increaseTo(dueAt);
      expect(await engine.isInstallmentDue(1)).to.equal(true);
      // Due is not the same as liquidatable -- the grace period still stands.
      expect(await engine.checkLiquidatable(1)).to.equal(false);
    });

    it("is still safe on the last second of the grace period", async () => {
      await time.increaseTo(dueAt + BigInt(GRACE));
      expect(await engine.checkLiquidatable(1)).to.equal(false);
    });

    it("refuses a liquidation mined on the last second of the grace period", async () => {
      // increaseTo would mine the liquidation into the *next* block, a second
      // late, and pass for the wrong reason. Pin the timestamp of the block the
      // transaction itself lands in.
      await time.setNextBlockTimestamp(dueAt + BigInt(GRACE));
      await expect(engine.liquidate(1)).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    });

    it("becomes liquidatable one second after the grace period ends", async () => {
      await time.increaseTo(dueAt + BigInt(GRACE) + 1n);
      expect(await engine.checkLiquidatable(1)).to.equal(true);
    });

    it("agrees with repay() about what counts as on time, so the two cannot disagree", async () => {
      // A payment landing on the final grace second must be scored on time,
      // because that is the same instant liquidation is still refused.
      await time.increaseTo(dueAt + BigInt(GRACE) - 1n);
      const scoreBefore = await scores.scoreOf(borrower.address);
      await engine.connect(borrower).repay(1, await engine.installmentAmount(1));
      expect(await scores.scoreOf(borrower.address)).to.be.greaterThan(scoreBefore);
    });

    it("reports false for a loan id that does not exist", async () => {
      expect(await engine.checkLiquidatable(999)).to.equal(false);
    });
  });

  describe("liquidation recovery", () => {
    it("recovers the full outstanding balance when the allowance still covers it", async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
      const outstanding = await engine.outstandingOf(1);
      const poolBefore = await usdc.balanceOf(await engine.getAddress());

      await time.increase(14 * DAY + GRACE + 1);
      await expect(engine.liquidate(1))
        .to.emit(engine, "LoanLiquidated")
        .withArgs(1, borrower.address, outstanding, outstanding);

      expect(await usdc.balanceOf(await engine.getAddress())).to.equal(poolBefore + outstanding);
      expect(await engine.badDebt()).to.equal(0n);
      expect(await engine.activeDebtOf(borrower.address)).to.equal(0n);
    });

    it("books the whole debt as bad when the borrower has nothing left to take", async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
      const outstanding = await engine.outstandingOf(1);
      await usdc
        .connect(borrower)
        .transfer(owner.address, await usdc.balanceOf(borrower.address));

      await time.increase(14 * DAY + GRACE + 1);
      await engine.liquidate(1);

      expect(await engine.badDebt()).to.equal(outstanding);
    });
  });

  describe("the standing allowance behind every future draw", () => {
    it("refuses an origination the borrower has not approved", async () => {
      const w = await freshBorrower();
      await usdc.connect(w).approve(await engine.getAddress(), 0);
      await expect(
        engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "InsufficientAllowance");
    });

    /*
     * The allowance must cover the borrower's whole book, not just the loan
     * being opened. The engine checks `allowance >= totalOwed` for this loan
     * alone, so a borrower holding an allowance sized for one plan can open a
     * second one against the same approval -- and the merchant is paid out of
     * pool liquidity for both.
     */
    it("refuses a second loan the same approval cannot also cover", async () => {
      const w = await freshBorrower();
      const owed = owedFor(USDC(200), 4, 14 * DAY);

      // One approval, sized for exactly one plan. Nothing is drawn against it,
      // so it still reads as untouched when the second loan is opened.
      await usdc.connect(w).approve(await engine.getAddress(), owed);
      await engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY);

      await expect(
        engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "InsufficientAllowance");
    });

    it("refuses a second loan the standing allowance cannot also cover", async () => {
      /*
       * This is the regression guard for a real total-loss path.
       *
       * The check used to compare the allowance against this loan's totalOwed
       * alone. Nothing is drawn at origination, so the approval still read as
       * untouched when the next loan opened, and one approval sized for a
       * single plan supported as many loans as the credit limit allowed.
       * Settling the first legitimately exhausted the allowance; repay on the
       * second then reverted and liquidation recovered nothing, because
       * _recoverFromAllowance caps at an allowance of zero. The full balance
       * landed in badDebt while the borrower still held the money.
       *
       * The comparison is now against activeDebtOf + totalOwed, so the second
       * loan is refused at the door rather than becoming bad debt later.
       */
      const w = await freshBorrower();
      const owed = owedFor(USDC(200), 4, 14 * DAY);

      await usdc.connect(w).approve(await engine.getAddress(), owed);
      await engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY);

      await expect(
        engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "InsufficientAllowance");

      // Only the first loan exists, and it is fully covered.
      expect(await engine.activeDebtOf(w.address)).to.equal(owed);
      expect(await engine.badDebt()).to.equal(0n);
    });

    it("allows a second loan once the allowance covers the combined exposure", async () => {
      // The guard must not block a borrower who has actually approved enough.
      const w = await freshBorrower();
      const owed = owedFor(USDC(200), 4, 14 * DAY);

      await usdc.connect(w).approve(await engine.getAddress(), owed * 2n);
      await engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY);
      await engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY);

      expect(await engine.activeDebtOf(w.address)).to.equal(owed * 2n);
    });
  });

  describe("the standing allowance behind every future draw", () => {
    it("refuses an origination the borrower has not approved", async () => {
      const w = await freshBorrower();
      await usdc.connect(w).approve(await engine.getAddress(), 0);
      await expect(
        engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "InsufficientAllowance");
    });

    /*
     * The allowance must cover the borrower's whole book, not just the loan
     * being opened. The engine checks `allowance >= totalOwed` for this loan
     * alone, so a borrower holding an allowance sized for one plan can open a
     * second one against the same approval -- and the merchant is paid out of
     * pool liquidity for both.
     */
    it("refuses a second loan the same approval cannot also cover", async () => {
      const w = await freshBorrower();
      const owed = owedFor(USDC(200), 4, 14 * DAY);

      // One approval, sized for exactly one plan. Nothing is drawn against it,
      // so it still reads as untouched when the second loan is opened.
      await usdc.connect(w).approve(await engine.getAddress(), owed);
      await engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY);

      await expect(
        engine.createLoan(w.address, merchant.address, USDC(200), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "InsufficientAllowance");
    });

  });
});
