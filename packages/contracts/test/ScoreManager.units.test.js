/**
 * ScoreManager in isolation.
 *
 * The score is the only thing standing between the pool and an unsecured
 * withdrawal, so the exact tier boundaries matter: they are quoted to borrowers
 * ("get to 700 and your limit doubles") and read by the checkout SDK, and a
 * limit that disagrees with what the engine enforces is a refused checkout the
 * user was told would work.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => BigInt(Math.round(n * 1e6));

describe("ScoreManager", () => {
  let scores, vault, usdc, owner, user, writer, outsider;

  beforeEach(async () => {
    [owner, user, writer, outsider] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    vault = await (
      await ethers.getContractFactory("CollateralVault")
    ).deploy(owner.address, await usdc.getAddress());
    await scores.setWriter(writer.address, true);
  });

  describe("a wallet with no history", () => {
    it("reads at the starting score without anything ever being written", async () => {
      expect(await scores.scoreOf(user.address)).to.equal(await scores.STARTING_SCORE());
      expect(await scores.STARTING_SCORE()).to.equal(600);
    });

    it("gets the entry-tier credit limit", async () => {
      expect(await scores.baseLimitOf(user.address)).to.equal(USDC(500));
      expect(await scores.creditLimitOf(user.address)).to.equal(USDC(500));
    });

    it("reports a synthetic profile rather than an empty struct", async () => {
      const p = await scores.profileOf(user.address);
      expect(p.score).to.equal(600);
      expect(p.onTimePayments).to.equal(0);
      expect(p.initialized).to.equal(false);
    });
  });

  describe("score movement", () => {
    it("adds exactly the on-time bonus and counts the payment", async () => {
      const bonus = await scores.ON_TIME_BONUS();
      await expect(scores.connect(writer).recordOnTimePayment(user.address))
        .to.emit(scores, "ScoreChanged")
        .withArgs(user.address, 600, 600n + bonus, "on-time payment");

      expect(await scores.scoreOf(user.address)).to.equal(600n + bonus);
      expect((await scores.profileOf(user.address)).onTimePayments).to.equal(1);
    });

    it("subtracts more for a late payment than a good one earns", async () => {
      const bonus = await scores.ON_TIME_BONUS();
      const penalty = await scores.LATE_PENALTY();
      // Trust is slow to earn and fast to lose; the asymmetry is the policy.
      expect(penalty).to.be.greaterThan(bonus);

      await scores.connect(writer).recordLatePayment(user.address);
      expect(await scores.scoreOf(user.address)).to.equal(600n - penalty);
      expect((await scores.profileOf(user.address)).latePayments).to.equal(1);
    });

    it("costs the most for a liquidation", async () => {
      const penalty = await scores.DEFAULT_PENALTY();
      await scores.connect(writer).recordLiquidation(user.address);
      expect(await scores.scoreOf(user.address)).to.equal(600n - penalty);
      expect((await scores.profileOf(user.address)).liquidations).to.equal(1);
    });

    it("clamps at the ceiling however many payments land", async () => {
      for (let i = 0; i < 40; i++) {
        await scores.connect(writer).recordOnTimePayment(user.address);
      }
      expect(await scores.scoreOf(user.address)).to.equal(await scores.MAX_SCORE());
    });

    it("stamps first-seen on the write that creates the profile", async () => {
      await scores.connect(writer).recordOnTimePayment(user.address);
      const p = await scores.profileOf(user.address);
      expect(p.initialized).to.equal(true);
      expect(p.firstSeenAt).to.be.greaterThan(0n);
    });
  });

  describe("credit limit tiers", () => {
    /// Drive the score to a target by repeating whichever write moves it there.
    async function driveTo(target) {
      const bonus = Number(await scores.ON_TIME_BONUS());
      const steps = Math.ceil((target - 600) / bonus);
      for (let i = 0; i < steps; i++) {
        await scores.connect(writer).recordOnTimePayment(user.address);
      }
    }

    it("holds the floor tier below 580", async () => {
      await scores.connect(writer).recordLatePayment(user.address); // 600 -> 560
      expect(await scores.scoreOf(user.address)).to.equal(560);
      expect(await scores.baseLimitOf(user.address)).to.equal(USDC(200));
    });

    it("steps up at 670", async () => {
      await driveTo(670);
      expect(await scores.scoreOf(user.address)).to.be.greaterThanOrEqual(670);
      expect(await scores.baseLimitOf(user.address)).to.equal(USDC(1_000));
    });

    it("steps up at 740", async () => {
      await driveTo(740);
      expect(await scores.baseLimitOf(user.address)).to.equal(USDC(2_500));
    });

    it("reaches the top tier at 800", async () => {
      await driveTo(800);
      expect(await scores.baseLimitOf(user.address)).to.equal(USDC(5_000));
    });
  });

  describe("the collateral boost", () => {
    beforeEach(async () => {
      await scores.setCollateralVault(await vault.getAddress());
      await usdc.mint(user.address, USDC(1_000));
      await usdc.connect(user).approve(await vault.getAddress(), USDC(1_000));
    });

    it("adds the vault's boost on top of the score-derived limit", async () => {
      const base = await scores.baseLimitOf(user.address);
      await vault.connect(user).lock(USDC(100));

      // 150% of the locked face value, by the default multiplier.
      expect(await vault.creditBoostOf(user.address)).to.equal(USDC(150));
      expect(await scores.creditLimitOf(user.address)).to.equal(base + USDC(150));
    });

    it("keeps baseLimitOf free of collateral, so the two levers stay separable", async () => {
      const base = await scores.baseLimitOf(user.address);
      await vault.connect(user).lock(USDC(100));
      expect(await scores.baseLimitOf(user.address)).to.equal(base);
    });

    it("falls back to the score limit when no vault is configured", async () => {
      await scores.setCollateralVault(ethers.ZeroAddress);
      expect(await scores.creditLimitOf(user.address)).to.equal(
        await scores.baseLimitOf(user.address)
      );
    });

    /*
     * ScoreManager documents creditLimitOf as defensive: "an unreachable or
     * misbehaving vault degrades to no boost rather than reverting every loan
     * in the protocol". These two tests pin down which halves of that claim
     * hold, because creditLimitOf is on the origination path -- anything that
     * makes it revert stops every loan in the protocol, not just this borrower.
     */
    it("degrades to no boost when the configured vault is a contract without the method", async () => {
      // A real contract at the address, wrong ABI: the call itself reverts and
      // the try/catch does its job.
      await scores.setCollateralVault(await usdc.getAddress());
      expect(await scores.creditLimitOf(user.address)).to.equal(
        await scores.baseLimitOf(user.address)
      );
    });

    it("refuses a vault address with no code, rather than bricking origination", async () => {
      /*
       * try/catch cannot save this one, which is why the setter has to.
       *
       * A decode failure from a codeless address is not catchable in Solidity,
       * so creditLimitOf would revert rather than degrade to "no boost" -- and
       * createLoan calls it on every origination, so a single owner typo bricked
       * lending for every borrower in the protocol. Refusing the address costs
       * one code-length check; discovering it in production costs the protocol.
       */
      await expect(
        scores.setCollateralVault(outsider.address)
      ).to.be.revertedWithCustomError(scores, "VaultNotAContract");

      // The previously configured vault is untouched, so nothing is bricked.
      expect(await scores.creditLimitOf(user.address)).to.be.a("bigint");
    });

    it("still allows clearing the vault with the zero address", async () => {
      await scores.setCollateralVault(ethers.ZeroAddress);
      expect(await scores.creditLimitOf(user.address)).to.equal(
        await scores.baseLimitOf(user.address)
      );
    });
  });

  describe("write access", () => {
    it("refuses every write from an unregistered caller", async () => {
      for (const fn of ["recordOnTimePayment", "recordLatePayment", "recordLiquidation"]) {
        await expect(
          scores.connect(outsider)[fn](user.address)
        ).to.be.revertedWithCustomError(scores, "NotWriter");
      }
    });

    it("refuses writes once the writer is revoked", async () => {
      await scores.setWriter(writer.address, false);
      await expect(
        scores.connect(writer).recordOnTimePayment(user.address)
      ).to.be.revertedWithCustomError(scores, "NotWriter");
    });

    it("refuses to let a non-owner appoint a writer", async () => {
      await expect(
        scores.connect(outsider).setWriter(outsider.address, true)
      ).to.be.revertedWithCustomError(scores, "OwnableUnauthorizedAccount");
    });
  });
});
