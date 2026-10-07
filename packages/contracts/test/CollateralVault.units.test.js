/**
 * CollateralVault in isolation.
 *
 * `withdrawable` is the number the UI shows a borrower before they press the
 * button, so it has to agree with what `withdraw` will actually allow. Anywhere
 * the two disagree is a support ticket at best and a released-while-securing
 * bug at worst.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const DAY = 24 * 60 * 60;

describe("CollateralVault units", () => {
  let usdc, scores, engine, vault, owner, user, merchant, outsider;

  beforeEach(async () => {
    [owner, user, merchant, outsider] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    engine = await (
      await ethers.getContractFactory("PolarisLoanEngine")
    ).deploy(
      owner.address,
      await usdc.getAddress(),
      await scores.getAddress(),
      owner.address,
      3 * DAY,
    0
    );
    vault = await (
      await ethers.getContractFactory("CollateralVault")
    ).deploy(owner.address, await usdc.getAddress());

    await scores.setWriter(await engine.getAddress(), true);
    await scores.setCollateralVault(await vault.getAddress());
    await vault.setLoanEngine(await engine.getAddress());
    await vault.setSeizer(await engine.getAddress(), true);
    await engine.setCollateralVault(await vault.getAddress());
    await engine.setOriginator(owner.address, true);

    await usdc.approve(await engine.getAddress(), USDC(1_000_000));
    await engine.fund(USDC(500_000));

    await usdc.mint(user.address, USDC(5_000));
    await usdc.connect(user).approve(await vault.getAddress(), USDC(5_000));
    await usdc.connect(user).approve(await engine.getAddress(), USDC(5_000));
  });

  describe("locking", () => {
    it("takes custody of the tokens and records the position", async () => {
      const before = await usdc.balanceOf(user.address);
      await expect(vault.connect(user).lock(USDC(100)))
        .to.emit(vault, "CollateralLocked")
        .withArgs(user.address, USDC(100), USDC(100));

      expect(await usdc.balanceOf(user.address)).to.equal(before - USDC(100));
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(USDC(100));
      expect(await vault.lockedOf(user.address)).to.equal(USDC(100));
      expect(await vault.totalLocked()).to.equal(USDC(100));
    });

    it("grants exactly 150% of face value as headroom", async () => {
      await vault.connect(user).lock(USDC(400));
      expect(await vault.creditBoostOf(user.address)).to.equal(USDC(600));
    });

    it("accumulates across separate locks", async () => {
      await vault.connect(user).lock(USDC(100));
      await vault.connect(user).lock(USDC(50));
      expect(await vault.lockedOf(user.address)).to.equal(USDC(150));
      expect(await vault.creditBoostOf(user.address)).to.equal(USDC(225));
    });

    it("rejects a zero lock", async () => {
      await expect(vault.connect(user).lock(0)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount"
      );
    });

    it("tracks the multiplier when the protocol changes it", async () => {
      await vault.connect(user).lock(USDC(100));
      await vault.setCreditMultiplierBps(20_000);
      expect(await vault.creditBoostOf(user.address)).to.equal(USDC(200));
    });

    it("refuses a multiplier of zero or one past the cap", async () => {
      const max = await vault.MAX_MULTIPLIER_BPS();
      await expect(vault.setCreditMultiplierBps(0)).to.be.revertedWithCustomError(
        vault,
        "InvalidMultiplier"
      );
      await expect(vault.setCreditMultiplierBps(max + 1n)).to.be.revertedWithCustomError(
        vault,
        "InvalidMultiplier"
      );
    });
  });

  describe("withdrawable tracks withdraw", () => {
    beforeEach(async () => {
      await vault.connect(user).lock(USDC(200));
    });

    it("is the whole position while the borrower owes nothing", async () => {
      expect(await vault.withdrawable(user.address)).to.equal(USDC(200));
      await expect(vault.connect(user).withdraw(USDC(200))).to.not.be.reverted;
      expect(await vault.withdrawable(user.address)).to.equal(0n);
    });

    it("drops to zero the moment a loan is outstanding", async () => {
      await engine.createLoan(user.address, merchant.address, USDC(300), 4, 14 * DAY);

      expect(await vault.withdrawable(user.address)).to.equal(0n);
      await expect(vault.connect(user).withdraw(1))
        .to.be.revertedWithCustomError(vault, "DebtOutstanding")
        .withArgs(await engine.activeDebtOf(user.address));
    });

    it("returns to the full position once the loan is settled", async () => {
      await engine.createLoan(user.address, merchant.address, USDC(300), 4, 14 * DAY);
      await engine.connect(user).repay(1, (await engine.getLoan(1)).totalOwed);

      expect(await vault.withdrawable(user.address)).to.equal(USDC(200));
      await expect(vault.connect(user).withdraw(USDC(200))).to.not.be.reverted;
    });

    it("cannot release more than is locked", async () => {
      await expect(
        vault.connect(user).withdraw(USDC(201))
      ).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
    });

    it("rejects a zero withdrawal", async () => {
      await expect(vault.connect(user).withdraw(0)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount"
      );
    });

    it("reports the full position when no engine is wired, since nothing can owe", async () => {
      await vault.setLoanEngine(ethers.ZeroAddress);
      expect(await vault.withdrawable(user.address)).to.equal(USDC(200));
    });

    it("lets a partial withdrawal leave the rest locked", async () => {
      await vault.connect(user).withdraw(USDC(75));
      expect(await vault.lockedOf(user.address)).to.equal(USDC(125));
      expect(await vault.totalLocked()).to.equal(USDC(125));
      expect(await vault.withdrawable(user.address)).to.equal(USDC(125));
    });
  });

  describe("collateral as credit headroom", () => {
    it("opens a loan the borrower's score alone could not carry", async () => {
      // Entry tier is 500 USDC; 400 of collateral buys 600 more.
      await expect(
        engine.createLoan(user.address, merchant.address, USDC(800), 4, 14 * DAY)
      ).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");

      await vault.connect(user).lock(USDC(400));
      await expect(engine.createLoan(user.address, merchant.address, USDC(800), 4, 14 * DAY))
        .to.not.be.reverted;
    });
  });

  describe("seizure", () => {
    it("takes only what is there and leaves the position empty", async () => {
      await vault.connect(user).lock(USDC(50));
      await engine.createLoan(user.address, merchant.address, USDC(400), 4, 14 * DAY);
      // Strip the borrower so the allowance path recovers nothing and the
      // shortfall has to come out of collateral.
      await usdc.connect(user).transfer(owner.address, await usdc.balanceOf(user.address));

      await time.increase(14 * DAY + 3 * DAY + 1);
      await engine.liquidate(1);

      expect(await vault.lockedOf(user.address)).to.equal(0n);
      expect(await vault.seizedOf(user.address)).to.equal(USDC(50));
      expect(await vault.totalLocked()).to.equal(0n);
      expect(await vault.creditBoostOf(user.address)).to.equal(0n);
    });

    it("refuses an unregistered seizer", async () => {
      await vault.connect(user).lock(USDC(50));
      await expect(
        vault.connect(outsider).seize(user.address, USDC(10), outsider.address)
      ).to.be.revertedWithCustomError(vault, "NotSeizer");
    });

    it("is a no-op rather than a revert when there is nothing to seize", async () => {
      await vault.setSeizer(owner.address, true);
      const taken = await vault.seize.staticCall(user.address, USDC(10), owner.address);
      expect(taken).to.equal(0n);
    });
  });

  describe("admin access", () => {
    it("refuses to let a non-owner appoint a seizer", async () => {
      await expect(
        vault.connect(outsider).setSeizer(outsider.address, true)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("refuses to let a non-owner repoint the loan engine", async () => {
      await expect(
        vault.connect(outsider).setLoanEngine(outsider.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("refuses to let a non-owner change the multiplier", async () => {
      await expect(
        vault.connect(outsider).setCreditMultiplierBps(30_000)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });
});
