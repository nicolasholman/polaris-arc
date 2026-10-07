const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const DAY = 24 * 60 * 60;
const MONTH = 30 * DAY;

describe("PolarisPayments", () => {
  let usdc, pay, owner, payer, merchant, keeper, treasury;

  beforeEach(async () => {
    [owner, payer, merchant, keeper, treasury] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    pay = await (
      await ethers.getContractFactory("PolarisPayments")
    ).deploy(owner.address, await usdc.getAddress(), treasury.address, 0);

    await usdc.mint(payer.address, USDC(10_000));
    await usdc.connect(payer).approve(await pay.getAddress(), USDC(10_000));
  });

  describe("direct payment", () => {
    it("pays the merchant net of fee and routes the fee to treasury", async () => {
      const before = await usdc.balanceOf(merchant.address);
      await pay.connect(payer).pay(merchant.address, USDC(100), "ORD-1");

      // 0.5% fee: merchant gets 99.50, treasury 0.50
      expect(await usdc.balanceOf(merchant.address)).to.equal(before + USDC(99.5));
      expect(await usdc.balanceOf(treasury.address)).to.equal(USDC(0.5));
    });

    it("refuses to charge the same order twice, so a retrying checkout cannot double-charge", async () => {
      await pay.connect(payer).pay(merchant.address, USDC(100), "ORD-1");
      await expect(
        pay.connect(payer).pay(merchant.address, USDC(100), "ORD-1")
      ).to.be.revertedWithCustomError(pay, "DuplicatePayment");
    });

    it("scopes the order id to the merchant, so two merchants can use the same id", async () => {
      await pay.connect(payer).pay(merchant.address, USDC(10), "ORD-1");
      await expect(pay.connect(payer).pay(keeper.address, USDC(10), "ORD-1")).to.not.be.reverted;
    });

    it("records the payment for later lookup", async () => {
      await pay.connect(payer).pay(merchant.address, USDC(42), "ORD-9");
      const p = await pay.paymentFor(merchant.address, "ORD-9");
      expect(p.payer).to.equal(payer.address);
      expect(p.amount).to.equal(USDC(42));
      expect(p.paidAt).to.be.greaterThan(0);
    });

    it("rejects a zero payment", async () => {
      await expect(
        pay.connect(payer).pay(merchant.address, 0, "ORD-0")
      ).to.be.revertedWithCustomError(pay, "ZeroAmount");
    });
  });

  describe("subscriptions", () => {
    let planId;

    beforeEach(async () => {
      await pay.connect(merchant).createPlan(USDC(20), MONTH, "Pro");
      planId = await pay.planCount();
    });

    it("charges the first period at subscribe time, so a plan is never active having collected nothing", async () => {
      const before = await usdc.balanceOf(merchant.address);
      await pay.connect(payer).subscribe(planId);

      expect(await usdc.balanceOf(merchant.address)).to.equal(before + USDC(19.9));
      const s = await pay.getSubscription(1);
      expect(s.periodsCharged).to.equal(1);
      expect(s.status).to.equal(0); // Active
    });

    it("is not chargeable again until the period elapses", async () => {
      await pay.connect(payer).subscribe(planId);
      expect(await pay.isChargeDue(1)).to.equal(false);
      await expect(pay.connect(keeper).chargeDue(1)).to.be.revertedWithCustomError(pay, "NotDue");
    });

    it("lets a third-party keeper collect once due, without the subscriber online", async () => {
      await pay.connect(payer).subscribe(planId);
      await time.increase(MONTH + 1);

      expect(await pay.isChargeDue(1)).to.equal(true);
      const before = await usdc.balanceOf(merchant.address);
      await pay.connect(keeper).chargeDue(1);

      expect(await usdc.balanceOf(merchant.address)).to.equal(before + USDC(19.9));
      expect((await pay.getSubscription(1)).periodsCharged).to.equal(2);
    });

    it("blocks a double subscribe to the same plan", async () => {
      await pay.connect(payer).subscribe(planId);
      await expect(pay.connect(payer).subscribe(planId)).to.be.revertedWithCustomError(
        pay,
        "AlreadySubscribed"
      );
    });

    it("lets the subscriber cancel unilaterally, with no merchant cooperation", async () => {
      await pay.connect(payer).subscribe(planId);
      await pay.connect(payer).cancel(1);

      expect((await pay.getSubscription(1)).status).to.equal(1); // Cancelled
      await time.increase(MONTH + 1);
      expect(await pay.isChargeDue(1)).to.equal(false);
      await expect(pay.connect(keeper).chargeDue(1)).to.be.revertedWithCustomError(
        pay,
        "SubscriptionNotActive"
      );
    });

    it("stops taking money the moment it is cancelled", async () => {
      await pay.connect(payer).subscribe(planId);
      await pay.connect(payer).cancel(1);
      const before = await usdc.balanceOf(payer.address);

      await time.increase(MONTH * 3);
      await expect(pay.connect(keeper).chargeDue(1)).to.be.reverted;

      expect(await usdc.balanceOf(payer.address)).to.equal(before);
    });

    it("skips a missed period rather than stacking it, so an absent subscriber is not hit with a backlog", async () => {
      await pay.connect(payer).subscribe(planId);
      // Return long after the charge window has closed.
      await time.increase(MONTH + 30 * DAY);

      const before = await usdc.balanceOf(payer.address);
      await pay.connect(keeper).chargeDue(1);

      // Nothing charged for the skipped period.
      expect(await usdc.balanceOf(payer.address)).to.equal(before);
      const s = await pay.getSubscription(1);
      expect(s.missedCharges).to.equal(1);
      expect(s.periodsCharged).to.equal(1);
      // And the schedule has moved forward, not fallen further behind.
      expect(s.nextChargeAt).to.be.greaterThan((await time.latest()) - MONTH);
    });

    it("lapses after three consecutive misses", async () => {
      await pay.connect(payer).subscribe(planId);
      for (let i = 0; i < 3; i++) {
        await time.increase(MONTH + 30 * DAY);
        await pay.connect(keeper).chargeDue(1);
      }
      expect((await pay.getSubscription(1)).status).to.equal(2); // Lapsed
    });

    it("resets the miss counter after a successful charge", async () => {
      await pay.connect(payer).subscribe(planId);
      await time.increase(MONTH + 30 * DAY);
      await pay.connect(keeper).chargeDue(1); // miss
      expect((await pay.getSubscription(1)).missedCharges).to.equal(1);

      const s = await pay.getSubscription(1);
      await time.increaseTo(Number(s.nextChargeAt) + 1);
      await pay.connect(keeper).chargeDue(1); // success
      expect((await pay.getSubscription(1)).missedCharges).to.equal(0);
    });

    it("cannot charge against a deactivated plan's new subscribers", async () => {
      await pay.connect(merchant).deactivatePlan(planId);
      await expect(pay.connect(payer).subscribe(planId)).to.be.revertedWithCustomError(
        pay,
        "PlanNotActive"
      );
    });

    it("rejects an implausible period", async () => {
      await expect(
        pay.connect(merchant).createPlan(USDC(5), 60, "TooShort")
      ).to.be.revertedWithCustomError(pay, "InvalidPeriod");
      await expect(
        pay.connect(merchant).createPlan(USDC(5), 400 * DAY, "TooLong")
      ).to.be.revertedWithCustomError(pay, "InvalidPeriod");
    });

    it("fails the charge when the subscriber has revoked their allowance", async () => {
      await pay.connect(payer).subscribe(planId);
      await usdc.connect(payer).approve(await pay.getAddress(), 0);
      await time.increase(MONTH + 1);
      await expect(pay.connect(keeper).chargeDue(1)).to.be.reverted;
    });
  });
});

describe("CollateralVault", () => {
  let usdc, scores, engine, vault, owner, borrower, merchant, keeper;

  beforeEach(async () => {
    [owner, borrower, merchant, keeper] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    engine = await (
      await ethers.getContractFactory("PolarisLoanEngine")
    ).deploy(owner.address, await usdc.getAddress(), await scores.getAddress(), owner.address, 3 * DAY, 0);
    vault = await (
      await ethers.getContractFactory("CollateralVault")
    ).deploy(owner.address, await usdc.getAddress());

    await scores.setWriter(await engine.getAddress(), true);
    await scores.setCollateralVault(await vault.getAddress());
    await vault.setLoanEngine(await engine.getAddress());
    await vault.setSeizer(owner.address, true);
    await engine.setOriginator(owner.address, true);

    await usdc.approve(await engine.getAddress(), USDC(500_000));
    await engine.fund(USDC(500_000));

    await usdc.mint(borrower.address, USDC(2000));
    await usdc.connect(borrower).approve(await engine.getAddress(), USDC(2000));
    await usdc.connect(borrower).approve(await vault.getAddress(), USDC(2000));
  });

  it("raises the credit limit by the multiplier when collateral is locked", async () => {
    const before = await scores.creditLimitOf(borrower.address);
    // A fresh borrower scores 600, which falls in the >=580 bracket -> 500.
    expect(before).to.equal(USDC(500));

    await vault.connect(borrower).lock(USDC(100));

    // 150% of 100 = 150 boost
    expect(await vault.creditBoostOf(borrower.address)).to.equal(USDC(150));
    expect(await scores.creditLimitOf(borrower.address)).to.equal(before + USDC(150));
  });

  it("keeps baseLimitOf free of collateral, so the two are separable", async () => {
    await vault.connect(borrower).lock(USDC(100));
    expect(await scores.baseLimitOf(borrower.address)).to.equal(USDC(500));
  });

  it("lets a borrower open a loan they could not afford without collateral", async () => {
    // 700 exceeds the 500 base limit.
    await expect(
      engine.createLoan(borrower.address, merchant.address, USDC(700), 4, 14 * DAY)
    ).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");

    await vault.connect(borrower).lock(USDC(400)); // +600 boost -> 1100 limit
    await expect(engine.createLoan(borrower.address, merchant.address, USDC(700), 4, 14 * DAY)).to
      .not.be.reverted;
  });

  it("blocks withdrawal while a loan is outstanding", async () => {
    await vault.connect(borrower).lock(USDC(200));
    await engine.createLoan(borrower.address, merchant.address, USDC(100), 4, 14 * DAY);

    expect(await vault.withdrawable(borrower.address)).to.equal(0);
    await expect(vault.connect(borrower).withdraw(USDC(50))).to.be.revertedWithCustomError(
      vault,
      "DebtOutstanding"
    );
  });

  it("releases collateral once the loan is fully repaid", async () => {
    await vault.connect(borrower).lock(USDC(200));
    await engine.createLoan(borrower.address, merchant.address, USDC(100), 2, 14 * DAY);

    for (let i = 0; i < 2; i++) {
      await engine.connect(borrower).repay(1, await engine.installmentAmount(1));
    }

    expect(await vault.withdrawable(borrower.address)).to.equal(USDC(200));
    const before = await usdc.balanceOf(borrower.address);
    await vault.connect(borrower).withdraw(USDC(200));
    expect(await usdc.balanceOf(borrower.address)).to.equal(before + USDC(200));
  });

  it("seizes collateral on default, capped at what is actually locked", async () => {
    await vault.connect(borrower).lock(USDC(80));
    const before = await usdc.balanceOf(merchant.address);

    // Ask for more than is locked; recovery must be partial, not a revert.
    const taken = await vault.seize.staticCall(borrower.address, USDC(500), merchant.address);
    expect(taken).to.equal(USDC(80));

    await vault.seize(borrower.address, USDC(500), merchant.address);
    expect(await usdc.balanceOf(merchant.address)).to.equal(before + USDC(80));
    expect(await vault.lockedOf(borrower.address)).to.equal(0);
  });

  it("refuses seizure from an unregistered seizer", async () => {
    await vault.connect(borrower).lock(USDC(50));
    await expect(
      vault.connect(keeper).seize(borrower.address, USDC(10), keeper.address)
    ).to.be.revertedWithCustomError(vault, "NotSeizer");
  });

  it("cannot withdraw more than is locked", async () => {
    await vault.connect(borrower).lock(USDC(10));
    await expect(vault.connect(borrower).withdraw(USDC(11))).to.be.revertedWithCustomError(
      vault,
      "InsufficientCollateral"
    );
  });

  it("survives an unset vault, so the protocol still works as pure credit", async () => {
    const fresh = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    expect(await fresh.creditLimitOf(borrower.address)).to.equal(USDC(500));
  });
});
