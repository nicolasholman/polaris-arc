const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const DAY = 24 * 60 * 60;

describe("PolarisLoanEngine", () => {
  let usdc, scores, engine, owner, borrower, merchant, keeper;

  beforeEach(async () => {
    [owner, borrower, merchant, keeper] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    engine = await (
      await ethers.getContractFactory("PolarisLoanEngine")
    ).deploy(owner.address, await usdc.getAddress(), await scores.getAddress(), owner.address, 3 * DAY, 0);

    await scores.setWriter(await engine.getAddress(), true);
    await engine.setOriginator(owner.address, true);

    await usdc.approve(await engine.getAddress(), USDC(500_000));
    await engine.fund(USDC(500_000));

    await usdc.mint(borrower.address, USDC(1000));
    await usdc.connect(borrower).approve(await engine.getAddress(), USDC(1000));
  });

  describe("origination", () => {
    it("pays the merchant up front and records the debt", async () => {
      const before = await usdc.balanceOf(merchant.address);
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);

      expect(await usdc.balanceOf(merchant.address)).to.equal(before + USDC(200));
      const loan = await engine.getLoan(1);
      expect(loan.borrower).to.equal(borrower.address);
      expect(loan.installmentCount).to.equal(4);
      expect(loan.totalOwed).to.be.greaterThan(USDC(200)); // principal + interest
    });

    it("refuses a plan that exceeds the borrower's credit limit", async () => {
      // Starting score 600 -> 500 USDC limit.
      await expect(
        engine.createLoan(borrower.address, merchant.address, USDC(900), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");
    });

    it("rejects an unregistered originator", async () => {
      await expect(
        engine
          .connect(keeper)
          .createLoan(borrower.address, merchant.address, USDC(100), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "NotOriginator");
    });
  });

  describe("collection", () => {
    beforeEach(async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
    });

    it("lets the keeper pull an installment without the borrower being online", async () => {
      const due = await engine.installmentAmount(1);
      const before = await usdc.balanceOf(borrower.address);

      // Called by a third party -- the keeper -- not the borrower. The keeper's
      // path takes no amount and only runs once the instalment is due; an
      // arbitrary-amount repay is the borrower's alone.
      await time.increaseTo(await engine.installmentDueAt(1, 0));
      await expect(engine.connect(keeper).repay(1, due)).to.be.revertedWithCustomError(
        engine,
        "NotBorrower"
      );
      await engine.connect(keeper).collectInstallment(1);

      expect(await usdc.balanceOf(borrower.address)).to.equal(before - due);
      expect((await engine.getLoan(1)).installmentsPaid).to.equal(1);
    });

    it("raises the credit score for an on-time payment", async () => {
      const before = await scores.scoreOf(borrower.address);
      await engine.connect(borrower).repay(1, await engine.installmentAmount(1));
      expect(await scores.scoreOf(borrower.address)).to.be.greaterThan(before);
    });

    it("lowers the score when the payment is late", async () => {
      await time.increase(20 * DAY); // past due + grace
      const before = await scores.scoreOf(borrower.address);
      await engine.connect(keeper).collectInstallment(1);
      expect(await scores.scoreOf(borrower.address)).to.be.lessThan(before);
    });

    it("closes the loan exactly, with no dust left owing", async () => {
      for (let i = 0; i < 4; i++) {
        await engine.connect(borrower).repay(1, await engine.installmentAmount(1));
      }
      const loan = await engine.getLoan(1);
      expect(loan.status).to.equal(1); // Repaid
      expect(await engine.outstandingOf(1)).to.equal(0n);
    });

    it("reverts when the borrower cannot cover the draw, so the keeper's simulation catches it", async () => {
      const due = await engine.installmentAmount(1);
      await usdc.connect(borrower).transfer(owner.address, await usdc.balanceOf(borrower.address));
      await time.increaseTo(await engine.installmentDueAt(1, 0));
      await expect(engine.connect(keeper).collectInstallment(1))
        .to.be.revertedWithCustomError(engine, "InsufficientBalance")
        .withArgs(0n, due);
    });
  });

  describe("liquidation (the check-and-execute pair)", () => {
    beforeEach(async () => {
      await engine.createLoan(borrower.address, merchant.address, USDC(200), 4, 14 * DAY);
    });

    it("is not liquidatable while the installment is not yet overdue", async () => {
      expect(await engine.checkLiquidatable(1)).to.equal(false);
    });

    it("is not liquidatable inside the grace period", async () => {
      await time.increase(14 * DAY + 1 * DAY);
      expect(await engine.checkLiquidatable(1)).to.equal(false);
    });

    it("becomes liquidatable once the grace period lapses", async () => {
      await time.increase(14 * DAY + 4 * DAY);
      expect(await engine.checkLiquidatable(1)).to.equal(true);
    });

    it("liquidate() reverts when the condition does not hold, so a stale read cannot liquidate a healthy loan", async () => {
      await expect(engine.liquidate(1)).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    });

    it("a last-second repayment makes the loan un-liquidatable again", async () => {
      await time.increase(14 * DAY + 4 * DAY);
      expect(await engine.checkLiquidatable(1)).to.equal(true);

      await engine.connect(borrower).repay(1, await engine.installmentAmount(1));

      expect(await engine.checkLiquidatable(1)).to.equal(false);
      await expect(engine.liquidate(1)).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    });

    it("liquidating penalises the score and closes the loan", async () => {
      await time.increase(14 * DAY + 4 * DAY);
      const before = await scores.scoreOf(borrower.address);

      await engine.liquidate(1);

      expect((await engine.getLoan(1)).status).to.equal(2); // Liquidated
      expect(await scores.scoreOf(borrower.address)).to.be.lessThan(before);
    });

    it("cannot liquidate twice", async () => {
      await time.increase(14 * DAY + 4 * DAY);
      await engine.liquidate(1);
      await expect(engine.liquidate(1)).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    });
  });

  describe("ScoreManager", () => {
    it("seeds a new user at the starting score", async () => {
      expect(await scores.scoreOf(keeper.address)).to.equal(600);
    });

    it("raises the credit limit as the score climbs", async () => {
      const before = await scores.creditLimitOf(borrower.address);
      await scores.setWriter(owner.address, true);
      for (let i = 0; i < 10; i++) {
        await scores.recordOnTimePayment(borrower.address);
      }
      expect(await scores.creditLimitOf(borrower.address)).to.be.greaterThan(before);
    });

    it("refuses score writes from an unregistered writer", async () => {
      await expect(
        scores.connect(keeper).recordOnTimePayment(borrower.address)
      ).to.be.revertedWithCustomError(scores, "NotWriter");
    });

    it("clamps the score at the floor", async () => {
      await scores.setWriter(owner.address, true);
      for (let i = 0; i < 10; i++) {
        await scores.recordLiquidation(borrower.address);
      }
      expect(await scores.scoreOf(borrower.address)).to.equal(300);
    });
  });
});
