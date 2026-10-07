/**
 * Underwriting the first line.
 *
 * The Chainlink DON attests facts about a wallet's life elsewhere; the score is
 * computed on chain from those facts, never attested. These tests hold the
 * formula to a hand-computed table, hold the off-chain mirror to the contract,
 * and prove the guards around the one write that sets a score without
 * repayment history: it runs once, on fresh evidence, never over bad history,
 * and it never opens a line above $1,000, not even for the one transaction
 * after it lands. A report must show a history before it opens anything: a
 * fresh account's empty report is refused, not scored at the floor. With
 * underwriting required, they prove that nothing but a
 * report opens an unsecured line: not a dust plan, not a default, not a late
 * payment, and not the collateral multiplier either. And they prove that a
 * line, once open, cannot be defaulted on for ever.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const mirror = require("../helpers/underwrite-mirror");
const { scoreFromFacts, isThinFile } = mirror;
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const AUSD = (n) => BigInt(Math.round(n * 1e6));
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const GRACE = 3 * DAY;
const BONUS_PERIOD = 7 * DAY;
const EVIDENCE_WINDOW = 15n * 60n;

const U16_MAX = 2 ** 16 - 1;
const U32_MAX = 2 ** 32 - 1;
const U64_MAX = 2n ** 64n - 1n;

const EMPTY = {
  walletAgeDays: 0,
  txCount: 0,
  stableBalance: 0n,
  defiTenureDays: 0,
  priorLiquidations: 0,
  relatedWallets: 0,
  exchangeFunded: false,
};

/// The least history a report may show and still open a line
/// (ScoreManager.isThinFile): 90 days and 10 transactions. It earns six
/// points of age, so it opens at 526, the $200 floor tier.
const HISTORY = { walletAgeDays: 90, txCount: 10 };

/// Every positive signal exactly at its cap.
const BEST = {
  walletAgeDays: 900,
  txCount: 1250,
  stableBalance: AUSD(5_000),
  defiTenureDays: 900,
  priorLiquidations: 0,
  relatedWallets: 0,
  exchangeFunded: true,
};

const facts = (overrides = {}, observedAt = 0n) => ({
  ...EMPTY,
  ...overrides,
  observedAt: BigInt(observedAt),
});

/*
 * The expected column is worked by hand from the specification, not from
 * either implementation, so the mirror and the contract cannot agree on the
 * same mistake:
 *   520 + min(age/30*2, 60) + min(tx/25, 50) + min(balance/$100, 50)
 *       + min(defi/30, 30) + (exchangeFunded ? 10 : 0)
 *       - 75*liquidations - min((related-3)*2, 80) when related > 3
 *   clamped to [300, 739]; declined when liquidations >= 2 or related >= 25.
 *
 * The positive caps sum to 720, so the 739 ceiling cannot be reached by any
 * input today; the BEST row pins the highest score the formula can produce.
 */
const VECTORS = [
  { name: "an empty wallet opens at the floor", f: {}, score: 520, declined: false },
  { name: "wallet age rounds down to whole months before doubling", f: { walletAgeDays: 59 }, score: 522, declined: false },
  { name: "wallet age earns two points a month", f: { walletAgeDays: 450 }, score: 550, declined: false },
  { name: "wallet age caps at 60 points", f: { walletAgeDays: 900 }, score: 580, declined: false },
  { name: "wallet age far past the cap earns nothing more", f: { walletAgeDays: 4_000_000_000 }, score: 580, declined: false },
  { name: "activity earns a point per 25 transactions", f: { txCount: 124 }, score: 524, declined: false },
  { name: "activity caps at 50 points", f: { txCount: 1250 }, score: 570, declined: false },
  { name: "activity far past the cap earns nothing more", f: { txCount: 999_999 }, score: 570, declined: false },
  { name: "a balance one unit under $100 earns nothing", f: { stableBalance: AUSD(100) - 1n }, score: 520, declined: false },
  { name: "balance earns a point per $100", f: { stableBalance: AUSD(250) }, score: 522, declined: false },
  { name: "balance caps at 50 points", f: { stableBalance: AUSD(5_000) }, score: 570, declined: false },
  { name: "a $10M balance earns nothing more", f: { stableBalance: AUSD(10_000_000) }, score: 570, declined: false },
  { name: "DeFi tenure earns a point a month", f: { defiTenureDays: 95 }, score: 523, declined: false },
  { name: "DeFi tenure caps at 30 points", f: { defiTenureDays: 900 }, score: 550, declined: false },
  { name: "DeFi tenure far past the cap earns nothing more", f: { defiTenureDays: 36_500 }, score: 550, declined: false },
  { name: "exchange funding adds 10", f: { exchangeFunded: true }, score: 530, declined: false },
  { name: "three related wallets cost nothing", f: { relatedWallets: 3 }, score: 520, declined: false },
  { name: "a fourth related wallet costs two points", f: { relatedWallets: 4 }, score: 518, declined: false },
  { name: "24 related wallets cost 42 and do not decline", f: { relatedWallets: 24 }, score: 478, declined: false },
  { name: "25 related wallets decline", f: { relatedWallets: 25 }, score: 476, declined: true },
  { name: "the cluster penalty caps at 80", f: { relatedWallets: 43 }, score: 440, declined: true },
  { name: "a huge cluster costs no more than the cap", f: { relatedWallets: 60_000 }, score: 440, declined: true },
  { name: "one prior liquidation costs 75 and does not decline", f: { priorLiquidations: 1 }, score: 445, declined: false },
  { name: "two prior liquidations decline", f: { priorLiquidations: 2 }, score: 370, declined: true },
  { name: "three prior liquidations clamp at the 300 floor", f: { priorLiquidations: 3 }, score: 300, declined: true },
  { name: "the best possible facts score 720, under the 739 ceiling", f: BEST, score: 720, declined: false },
  { name: "a strong wallet with one liquidation", f: { ...BEST, priorLiquidations: 1 }, score: 645, declined: false },
  { name: "a strong wallet in a small cluster", f: { ...BEST, relatedWallets: 10 }, score: 706, declined: false },
  { name: "a strong wallet declines on its cluster alone", f: { ...BEST, relatedWallets: 25 }, score: 676, declined: true },
  {
    name: "an ordinary wallet sums every signal",
    f: {
      walletAgeDays: 200,
      txCount: 300,
      stableBalance: AUSD(1_234.56),
      defiTenureDays: 61,
      relatedWallets: 5,
    },
    score: 554,
    declined: false,
  },
  {
    name: "every field at its maximum neither overflows nor escapes the floor",
    f: {
      walletAgeDays: U32_MAX,
      txCount: U32_MAX,
      stableBalance: U64_MAX,
      defiTenureDays: U32_MAX,
      priorLiquidations: U16_MAX,
      relatedWallets: U16_MAX,
      exchangeFunded: true,
    },
    score: 300,
    declined: true,
  },
];

/// Deterministic, so a failure reproduces.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("underwriting", () => {
  let ausd, scores, engine, vault, owner, underwriter, user, merchant, stranger;

  beforeEach(async () => {
    [owner, underwriter, user, merchant, stranger] = await ethers.getSigners();

    ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    engine = await (
      await ethers.getContractFactory("PolarisLoanEngine")
    ).deploy(
      owner.address,
      await ausd.getAddress(),
      await scores.getAddress(),
      owner.address,
      GRACE,
      0
    );
    vault = await (
      await ethers.getContractFactory("CollateralVault")
    ).deploy(owner.address, await ausd.getAddress());

    await scores.setWriter(await engine.getAddress(), true);
    // The CRE receiver, in production.
    await scores.setUnderwriter(underwriter.address, true);
    await scores.setCollateralVault(await vault.getAddress());
    await vault.setLoanEngine(await engine.getAddress());
    await vault.setSeizer(await engine.getAddress(), true);
    await engine.setCollateralVault(await vault.getAddress());
    await engine.setOriginator(owner.address, true);

    await ausd.mint(owner.address, AUSD(1_000_000));
    await ausd.approve(await engine.getAddress(), AUSD(1_000_000));
    await engine.fund(AUSD(500_000));

    for (const who of [user, stranger]) {
      await ausd.mint(who.address, AUSD(5_000));
      await ausd.connect(who).approve(await engine.getAddress(), AUSD(5_000));
      await ausd.connect(who).approve(await vault.getAddress(), AUSD(5_000));
    }
  });

  /// Facts observed at the latest block, so the report is a second old when it lands.
  async function fresh(overrides = {}) {
    return facts(overrides, await time.latest());
  }

  function borrow(who, principal) {
    return engine.createLoan(who.address, merchant.address, principal, 4, 14 * DAY);
  }

  describe("the JS mirror", () => {
    for (const v of VECTORS) {
      it(`agrees with the contract and the specification: ${v.name}`, async () => {
        const struct = facts(v.f);
        const mirror = scoreFromFacts(struct);
        const [score, declined] = await scores.scoreFromFacts(struct);

        expect(mirror).to.deep.equal({ score: v.score, declined: v.declined });
        expect(Number(score)).to.equal(v.score);
        expect(declined).to.equal(v.declined);
      });
    }

    it("agrees with the contract across a seeded sweep that straddles every threshold", async () => {
      const rand = mulberry32(0x5eed);
      const pick = (max) => Math.floor(rand() * (max + 1));
      for (let i = 0; i < 150; i++) {
        const struct = facts({
          walletAgeDays: pick(1_000),
          txCount: pick(1_400),
          stableBalance: BigInt(pick(6_000)) * 1_000_000n + BigInt(pick(999_999)),
          defiTenureDays: pick(1_000),
          priorLiquidations: pick(3),
          relatedWallets: pick(50),
          exchangeFunded: rand() < 0.5,
        });
        const mirror = scoreFromFacts(struct);
        const [score, declined] = await scores.scoreFromFacts(struct);
        const label = JSON.stringify(struct, (_, x) => (typeof x === "bigint" ? x.toString() : x));
        expect({ score: Number(score), declined }).to.deep.equal(mirror, label);
      }
    });
  });

  describe("recording a report", () => {
    it("sets the score, stamps first-seen and records the decline", async () => {
      const report = await fresh({ priorLiquidations: 2 });
      const tx = scores.connect(underwriter).underwrite(user.address, report);
      await expect(tx)
        .to.emit(scores, "Underwritten")
        .withArgs(user.address, 370, true, report.observedAt)
        .and.to.emit(scores, "ScoreChanged")
        .withArgs(user.address, 600, 370, "underwritten");

      const p = await scores.profileOf(user.address);
      expect(p.initialized).to.equal(true);
      expect(p.underwritten).to.equal(true);
      expect(p.score).to.equal(370);
      expect(p.declined).to.equal(true);
      expect(p.firstSeenAt).to.equal(BigInt(await time.latest()));
    });

    it("the least history a report may show opens the $200 floor line, below where a stranger reads today", async () => {
      await scores.connect(underwriter).underwrite(user.address, await fresh(HISTORY));
      expect(await scores.scoreOf(user.address)).to.equal(526);
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(200));
    });

    it("only a writer can underwrite: the underwriter role, which a repayment writer does not hold", async () => {
      // The engine's role: it records repayments and nothing else.
      const [, , , , , engineKey] = await ethers.getSigners();
      await scores.setWriter(engineKey.address, true);

      for (const caller of [stranger, owner, user, engineKey]) {
        await expect(
          scores.connect(caller).underwrite(user.address, await fresh(BEST))
        ).to.be.revertedWithCustomError(scores, "NotUnderwriter");
      }

      await expect(scores.setUnderwriter(underwriter.address, false))
        .to.emit(scores, "UnderwriterSet")
        .withArgs(underwriter.address, false);
      await expect(
        scores.connect(underwriter).underwrite(user.address, await fresh(BEST))
      ).to.be.revertedWithCustomError(scores, "NotUnderwriter");
      expect((await scores.profileOf(user.address)).initialized).to.equal(false);

      await expect(
        scores.connect(stranger).setUnderwriter(stranger.address, true)
      ).to.be.revertedWithCustomError(scores, "OwnableUnauthorizedAccount");
    });

    it("the underwriting receiver cannot pump a score past the $1,000 cap by recording payments", async () => {
      // One role per job: the key that opens first lines cannot also claim
      // repayments the engine never saw.
      await scores.connect(underwriter).underwrite(user.address, await fresh(BEST));
      expect(await scores.scoreOf(user.address)).to.equal(720);

      await expect(
        scores.connect(underwriter).recordOnTimePayment(user.address)
      ).to.be.revertedWithCustomError(scores, "NotWriter");
      await expect(
        scores.connect(underwriter).recordLiquidation(stranger.address)
      ).to.be.revertedWithCustomError(scores, "NotWriter");
      await expect(
        scores.connect(underwriter).recordLatePayment(stranger.address)
      ).to.be.revertedWithCustomError(scores, "NotWriter");

      expect(await scores.scoreOf(user.address)).to.equal(720);
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(1_000));
      expect((await scores.profileOf(stranger.address)).initialized).to.equal(false);
    });
  });

  describe("a thin file", () => {
    it("an empty report opens no line: a fresh account is refused, not scored at the floor", async () => {
      await scores.setRequireUnderwriting(true);
      // The reproduced attack: every fresh account's report is all zeros,
      // and each one opened $200 of unsecured credit.
      const sybils = (await ethers.getSigners()).slice(10, 15);
      for (const w of sybils) {
        await expect(scores.connect(underwriter).underwrite(w.address, await fresh()))
          .to.be.revertedWithCustomError(scores, "ThinFile")
          .withArgs(0, 0);
        const p = await scores.profileOf(w.address);
        expect(p.initialized).to.equal(false);
        expect(p.underwritten).to.equal(false);
        expect(await scores.creditLimitOf(w.address)).to.equal(0n);
        await expect(borrow(w, AUSD(10))).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");
      }
    });

    it("a report one day or one transaction short of the minimum is refused, and one at it is not", async () => {
      expect(await scores.MIN_HISTORY_DAYS()).to.equal(90n);
      expect(await scores.MIN_HISTORY_TXS()).to.equal(10n);
      const [, , , , , a, b, c] = await ethers.getSigners();
      const short = [
        [a, { ...HISTORY, walletAgeDays: 89 }],
        [b, { ...HISTORY, txCount: 9 }],
        // A balance is no history: the same dollars can visit every account.
        [c, { walletAgeDays: 3, txCount: 2, stableBalance: AUSD(5_000), exchangeFunded: true }],
      ];
      for (const [who, f] of short) {
        const report = await fresh(f);
        await expect(scores.connect(underwriter).underwrite(who.address, report))
          .to.be.revertedWithCustomError(scores, "ThinFile")
          .withArgs(report.walletAgeDays, report.txCount);
        expect((await scores.profileOf(who.address)).initialized).to.equal(false);
      }
      await expect(scores.connect(underwriter).underwrite(a.address, await fresh(HISTORY)))
        .to.emit(scores, "Underwritten")
        .withArgs(a.address, 526, false, anyValue);
    });

    it("is refused, not declined: the same account can bring a history wallet later", async () => {
      await scores.setRequireUnderwriting(true);
      await expect(
        scores.connect(underwriter).underwrite(user.address, await fresh({ walletAgeDays: 3, txCount: 2 }))
      ).to.be.revertedWithCustomError(scores, "ThinFile");
      // Collateral works meanwhile, at face value.
      await vault.connect(user).lock(AUSD(100));
      expect(await scores.creditLimitOf(user.address)).to.equal(AUSD(100));

      // Linking an old wallet makes the facts span its history too.
      await scores.connect(underwriter).underwrite(user.address, await fresh(BEST));
      expect(await scores.scoreOf(user.address)).to.equal(720);
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(1_000));
    });

    it("cannot dodge a decline: a thin report that disqualifies the wallet is still recorded", async () => {
      await expect(scores.connect(underwriter).underwrite(user.address, await fresh({ relatedWallets: 30 })))
        .to.emit(scores, "Underwritten")
        .withArgs(user.address, 466, true, anyValue);
      const p = await scores.profileOf(user.address);
      expect(p.declined).to.equal(true);
      expect(await scores.baseLimitOf(user.address)).to.equal(0n);
      await expect(
        scores.connect(underwriter).underwrite(user.address, await fresh(BEST))
      ).to.be.revertedWithCustomError(scores, "AlreadyHasRecord");
    });

    it("the JS mirror agrees with the contract on which reports are thin", async () => {
      const rand = mulberry32(0x7417);
      const cases = [{}, HISTORY, { ...HISTORY, walletAgeDays: 89 }, { ...HISTORY, txCount: 9 }, BEST];
      for (let i = 0; i < 60; i++) cases.push({ walletAgeDays: Math.floor(rand() * 200), txCount: Math.floor(rand() * 25) });
      for (const f of cases) {
        const struct = facts(f);
        const label = JSON.stringify(f, (_, x) => (typeof x === "bigint" ? x.toString() : x));
        expect(await scores.isThinFile(struct)).to.equal(isThinFile(struct), label);
      }
      expect(await scores.MIN_HISTORY_DAYS()).to.equal(mirror.MIN_HISTORY_DAYS);
      expect(await scores.MIN_HISTORY_TXS()).to.equal(mirror.MIN_HISTORY_TXS);
    });
  });

  describe("evidence freshness", () => {
    it("a stale report is refused", async () => {
      const landsAt = BigInt(await time.latest()) + 100n;

      await time.setNextBlockTimestamp(landsAt);
      await expect(
        scores.connect(underwriter).underwrite(user.address, facts(BEST, landsAt - EVIDENCE_WINDOW - 1n))
      ).to.be.revertedWithCustomError(scores, "StaleEvidence");

      // Exactly fifteen minutes old is the last moment it is accepted.
      await time.setNextBlockTimestamp(landsAt + 1n);
      await expect(
        scores.connect(underwriter).underwrite(user.address, facts(BEST, landsAt + 1n - EVIDENCE_WINDOW))
      ).to.emit(scores, "Underwritten");
    });

    it("a report from the future is refused", async () => {
      const landsAt = BigInt(await time.latest()) + 100n;

      await time.setNextBlockTimestamp(landsAt);
      await expect(
        scores.connect(underwriter).underwrite(user.address, facts(BEST, landsAt + 1n))
      ).to.be.revertedWithCustomError(scores, "StaleEvidence");

      // Observed in the very block it lands in is fine.
      await time.setNextBlockTimestamp(landsAt + 1n);
      await expect(
        scores.connect(underwriter).underwrite(user.address, facts(BEST, landsAt + 1n))
      ).to.emit(scores, "Underwritten");
    });
  });

  describe("a record is written once", () => {
    it("a second underwrite cannot reset a bad record left by a liquidation", async () => {
      await borrow(user, AUSD(200));
      await time.increase(14 * DAY + GRACE + 1);
      await engine.liquidate(1);
      const scarred = await scores.scoreOf(user.address);
      expect(scarred).to.equal(600 - 150);

      // A clean-looking report of the same wallet cannot write over the default.
      await expect(
        scores.connect(underwriter).underwrite(user.address, await fresh(BEST))
      ).to.be.revertedWithCustomError(scores, "AlreadyHasRecord");

      expect(await scores.scoreOf(user.address)).to.equal(scarred);
      expect((await scores.profileOf(user.address)).liquidations).to.equal(1);
    });

    it("a second underwrite cannot lift a decline", async () => {
      await scores.connect(underwriter).underwrite(user.address, await fresh({ priorLiquidations: 2 }));
      await expect(
        scores.connect(underwriter).underwrite(user.address, await fresh(BEST))
      ).to.be.revertedWithCustomError(scores, "AlreadyHasRecord");

      expect((await scores.profileOf(user.address)).declined).to.equal(true);
      expect(await scores.baseLimitOf(user.address)).to.equal(0n);
    });

    it("a record earned by repaying cannot be overwritten by a report either", async () => {
      await borrow(user, AUSD(200));
      await engine.connect(user).repay(1, await engine.installmentAmount(1));
      const earned = await scores.scoreOf(user.address);

      await expect(
        scores.connect(underwriter).underwrite(user.address, await fresh({ priorLiquidations: 3 }))
      ).to.be.revertedWithCustomError(scores, "AlreadyHasRecord");
      expect(await scores.scoreOf(user.address)).to.equal(earned);
    });
  });

  describe("the line it opens", () => {
    it("an underwritten line never opens above $1,000", async () => {
      // Every positive fact at its cap and far beyond it.
      const extreme = {
        walletAgeDays: U32_MAX,
        txCount: U32_MAX,
        stableBalance: U64_MAX,
        defiTenureDays: U32_MAX,
        exchangeFunded: true,
      };
      const [best] = await scores.scoreFromFacts(facts(extreme));
      expect(best).to.equal(720n);
      expect(best).to.be.lessThanOrEqual(await scores.MAX_UNDERWRITTEN_SCORE());
      expect(await scores.MAX_UNDERWRITTEN_SCORE()).to.be.lessThan(740n); // the $2,500 tier

      await scores.connect(underwriter).underwrite(user.address, await fresh(extreme));
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(1_000));
      expect(await scores.creditLimitOf(user.address)).to.equal(AUSD(1_000));

      // A plan owing more than $1,000 is refused; one inside the line opens.
      await expect(borrow(user, AUSD(1_000))).to.be.revertedWithCustomError(
        engine,
        "ExceedsCreditLimit"
      );
      await expect(borrow(user, AUSD(950))).to.not.be.reverted;
    });

    it("the floor plus every cap stays under the ceiling, so the $1,000 cap never rests on the clamp alone", async () => {
      const floor = await scores.UNDERWRITE_FLOOR();
      const caps = [
        await scores.MAX_AGE_POINTS(),
        await scores.MAX_ACTIVITY_POINTS(),
        await scores.MAX_BALANCE_POINTS(),
        await scores.MAX_DEFI_POINTS(),
        await scores.EXCHANGE_FUNDED_POINTS(),
      ];
      const reachable = caps.reduce((a, b) => a + b, floor);

      // Retuning a weight past the ceiling fails here, before the clamp is
      // the only thing holding the line at $1,000.
      expect(reachable).to.equal(720n);
      expect(reachable).to.be.lessThanOrEqual(await scores.MAX_UNDERWRITTEN_SCORE());

      // The constants are the ones the formula uses, and the mirror's.
      const [best] = await scores.scoreFromFacts(facts(BEST));
      expect(best).to.equal(reachable);
      expect(caps).to.deep.equal([
        mirror.MAX_AGE_POINTS,
        mirror.MAX_ACTIVITY_POINTS,
        mirror.MAX_BALANCE_POINTS,
        mirror.MAX_DEFI_POINTS,
        mirror.EXCHANGE_FUNDED_POINTS,
      ]);
      expect(floor).to.equal(mirror.UNDERWRITE_FLOOR);
      expect(await scores.MAX_UNDERWRITTEN_SCORE()).to.equal(mirror.MAX_UNDERWRITTEN_SCORE);
    });

    it("an underwritten wallet at the top score cannot buy the $2,500 tier with a dust plan", async () => {
      await scores.connect(underwriter).underwrite(user.address, await fresh(BEST));
      expect(await scores.scoreOf(user.address)).to.equal(720);

      // The reproduced attack: two base units over two hourly instalments.
      await engine.createLoan(user.address, merchant.address, 2n, 2, HOUR);
      for (let i = 0; i < 2; i++) {
        await expect(engine.connect(user).repay(1, 1n))
          .to.emit(engine, "OnTimeBonusWithheld")
          .withArgs(1, user.address);
      }
      expect((await engine.getLoan(1)).status).to.equal(1); // Repaid
      expect(await scores.scoreOf(user.address)).to.equal(720);
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(1_000));

      // Nor with a real plan paid off at once: the report started the clock.
      await engine.createLoan(user.address, merchant.address, AUSD(40), 2, HOUR);
      for (let i = 0; i < 2; i++) {
        await expect(engine.connect(user).repay(2, await engine.installmentAmount(2)))
          .to.emit(engine, "OnTimeBonusWithheld")
          .withArgs(2, user.address);
      }
      expect(await scores.scoreOf(user.address)).to.equal(720);
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(1_000));

      // 740 is reached by repaying over time: a bonus a week, two weeks.
      for (const [week, score, limit] of [
        [1, 732, 1_000],
        [2, 744, 2_500],
      ]) {
        await time.increase(BONUS_PERIOD);
        await engine.createLoan(user.address, merchant.address, AUSD(40), 2, HOUR);
        const id = await engine.loanCount();
        await engine.connect(user).repay(id, await engine.installmentAmount(id));
        expect(await scores.scoreOf(user.address), "week " + week).to.equal(score);
        expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(limit));
      }
    });

    it("two liquidations decline the line", async () => {
      await expect(
        scores
          .connect(underwriter)
          .underwrite(user.address, await fresh({ ...BEST, priorLiquidations: 2 }))
      )
        .to.emit(scores, "Underwritten")
        .withArgs(user.address, 570, true, (v) => v > 0n);

      // A 570 would otherwise be the $200 tier: the decline, not the score, closes it.
      expect(await scores.baseLimitOf(user.address)).to.equal(0n);
      expect(await scores.creditLimitOf(user.address)).to.equal(0n);
      await expect(borrow(user, AUSD(10))).to.be.revertedWithCustomError(
        engine,
        "ExceedsCreditLimit"
      );
    });

    it("a sybil cluster declines the line", async () => {
      // 24 related wallets is a penalty; 25 is a decline, even on a 676.
      await scores
        .connect(underwriter)
        .underwrite(stranger.address, await fresh({ ...BEST, relatedWallets: 24 }));
      expect(await scores.baseLimitOf(stranger.address)).to.equal(AUSD(1_000));

      await scores
        .connect(underwriter)
        .underwrite(user.address, await fresh({ ...BEST, relatedWallets: 25 }));
      expect(await scores.scoreOf(user.address)).to.equal(676);
      expect(await scores.baseLimitOf(user.address)).to.equal(0n);
      await expect(borrow(user, AUSD(10))).to.be.revertedWithCustomError(
        engine,
        "ExceedsCreditLimit"
      );
    });

    it("collateral still opens a line for someone declined", async () => {
      await scores.connect(underwriter).underwrite(user.address, await fresh({ priorLiquidations: 2 }));
      expect(await scores.creditLimitOf(user.address)).to.equal(0n);

      await vault.connect(user).lock(AUSD(200));
      // What is locked, at face value: the multiplier's extra half would be
      // unsecured credit, which is exactly what the decline refused.
      expect(await vault.creditBoostOf(user.address)).to.equal(AUSD(300));
      expect(await scores.creditLimitOf(user.address)).to.equal(AUSD(200));
      await expect(borrow(user, AUSD(190))).to.not.be.reverted;
      await expect(borrow(user, AUSD(10))).to.be.revertedWithCustomError(
        engine,
        "ExceedsCreditLimit"
      );
    });
  });

  describe("requireUnderwriting", () => {
    it("only the owner can require underwriting", async () => {
      await expect(
        scores.connect(stranger).setRequireUnderwriting(true)
      ).to.be.revertedWithCustomError(scores, "OwnableUnauthorizedAccount");
      await expect(scores.setRequireUnderwriting(true))
        .to.emit(scores, "RequireUnderwritingSet")
        .withArgs(true);
      expect(await scores.requireUnderwriting()).to.equal(true);
    });

    it("with requireUnderwriting on, a stranger with no record gets no unsecured line", async () => {
      await scores.setRequireUnderwriting(true);

      expect(await scores.baseLimitOf(stranger.address)).to.equal(0n);
      expect(await scores.creditLimitOf(stranger.address)).to.equal(0n);
      await expect(borrow(stranger, AUSD(10))).to.be.revertedWithCustomError(
        engine,
        "ExceedsCreditLimit"
      );

      // Collateral is the way in without a report, at its face value.
      await vault.connect(stranger).lock(AUSD(100));
      expect(await scores.creditLimitOf(stranger.address)).to.equal(AUSD(100));

      // And a report with a history opens the unsecured line.
      await scores.connect(underwriter).underwrite(user.address, await fresh(HISTORY));
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(200));
      await expect(borrow(user, AUSD(150))).to.not.be.reverted;
    });

    it("a never-underwritten wallet cannot reach a $5,000 unsecured line by repaying a 24-base-unit plan", async () => {
      await scores.setRequireUnderwriting(true);

      // The reproduced attack: 1 AUSD of collateral, a 24-base-unit plan over
      // 24 hourly instalments (interest rounds to zero), prepaid a unit at a
      // time. It used to earn +12 per call and end at 850.
      await vault.connect(stranger).lock(AUSD(1));
      await engine.createLoan(stranger.address, merchant.address, 24n, 24, HOUR);
      expect((await engine.getLoan(1)).totalOwed).to.equal(24n);
      for (let i = 0; i < 24; i++) {
        await expect(engine.connect(stranger).repay(1, 1n))
          .to.emit(engine, "OnTimeBonusWithheld")
          .withArgs(1, stranger.address);
      }
      expect((await engine.getLoan(1)).status).to.equal(1); // Repaid
      expect((await scores.profileOf(stranger.address)).initialized).to.equal(false);

      // A real plan prepaid instalment by instalment earns one bonus, not 24,
      // and even that record opens nothing without a report.
      await vault.connect(stranger).lock(AUSD(249));
      await engine.createLoan(stranger.address, merchant.address, AUSD(240), 24, HOUR);
      for (let i = 0; i < 24; i++) {
        await engine.connect(stranger).repay(2, await engine.installmentAmount(2));
      }
      expect((await engine.getLoan(2)).status).to.equal(1);
      expect(await scores.scoreOf(stranger.address)).to.equal(612);
      expect(await scores.baseLimitOf(stranger.address)).to.equal(0n);

      // Collateral back out: no line at all, let alone $5,000.
      await vault.connect(stranger).withdraw(AUSD(250));
      expect(await scores.creditLimitOf(stranger.address)).to.equal(0n);
      await expect(
        engine.createLoan(stranger.address, merchant.address, AUSD(4_900), 1, 30 * DAY)
      ).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");
      await expect(borrow(stranger, AUSD(10))).to.be.revertedWithCustomError(
        engine,
        "ExceedsCreditLimit"
      );
    });

    it("a defaulted secured plan never grants a never-underwritten wallet an unsecured line", async () => {
      await scores.setRequireUnderwriting(true);
      expect(await scores.baseLimitOf(user.address)).to.equal(0n);

      // The reproduced attack: 1 AUSD locked, a plan for all of it, allowance
      // revoked, liquidated. The record used to read as the $200 tier.
      await vault.connect(stranger).lock(AUSD(1));
      expect(await scores.creditLimitOf(stranger.address)).to.equal(AUSD(1));
      await engine.createLoan(stranger.address, merchant.address, AUSD(0.99), 1, HOUR);
      await ausd.connect(stranger).approve(await engine.getAddress(), 0);
      await time.increase(HOUR + GRACE + 1);
      await engine.connect(merchant).liquidate(1);

      const p = await scores.profileOf(stranger.address);
      expect(p.score).to.equal(450);
      expect(p.liquidations).to.equal(1);
      expect(p.underwritten).to.equal(false);

      // A defaulter gets no more than a clean stranger: nothing unsecured,
      // only the few units of collateral the seizure left behind.
      expect(await scores.baseLimitOf(stranger.address)).to.equal(0n);
      expect(await scores.creditLimitOf(stranger.address)).to.equal(
        await vault.lockedOf(stranger.address)
      );
      expect(await vault.lockedOf(stranger.address)).to.be.lessThan(AUSD(0.01));
      await ausd.connect(stranger).approve(await engine.getAddress(), AUSD(5_000));
      await expect(
        engine.createLoan(stranger.address, merchant.address, AUSD(195), 1, 30 * DAY)
      ).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");

      // And no report can be written over the default, good or bad.
      for (const report of [BEST, { priorLiquidations: 5, relatedWallets: 100 }]) {
        await expect(
          scores.connect(underwriter).underwrite(stranger.address, await fresh(report))
        ).to.be.revertedWithCustomError(scores, "AlreadyHasRecord");
      }
      expect(await scores.scoreOf(stranger.address)).to.equal(450);

      // The secured path stays open to it, and the default cost the pool nothing.
      expect(await engine.badDebt()).to.equal(0n);
      await vault.connect(stranger).lock(AUSD(100));
      expect(await scores.creditLimitOf(stranger.address)).to.equal(
        await vault.lockedOf(stranger.address)
      );
    });

    it("a late payment on the secured path never opens an unsecured line either", async () => {
      await scores.setRequireUnderwriting(true);
      await vault.connect(stranger).lock(AUSD(250));
      await borrow(stranger, AUSD(200));

      await time.increaseTo((await engine.installmentDueAt(1, 0)) + BigInt(GRACE) + 1n);
      await engine.connect(merchant).collectInstallment(1);
      expect(await scores.scoreOf(stranger.address)).to.equal(560);
      expect(await scores.baseLimitOf(stranger.address)).to.equal(0n);
      expect(await scores.creditLimitOf(stranger.address)).to.equal(AUSD(250));
    });

    it("one late mark on the secured path, collected a second past grace, no longer bars a wallet from underwriting for good", async () => {
      await scores.setRequireUnderwriting(true);

      // Two identical borrowers; only `user` was underwritten before borrowing.
      await scores.connect(underwriter).underwrite(user.address, await fresh(BEST));
      for (const who of [user, stranger]) {
        await vault.connect(who).lock(AUSD(250));
        await borrow(who, AUSD(200));
      }

      // The keeper, or a hostile relayer, lands both first instalments one
      // second past grace.
      for (const id of [1n, 2n]) {
        await time.setNextBlockTimestamp((await engine.installmentDueAt(id, 0)) + BigInt(GRACE) + 1n);
        await engine.connect(merchant).collectInstallment(id);
      }
      expect(await scores.scoreOf(user.address)).to.equal(680);
      expect(await scores.scoreOf(stranger.address)).to.equal(560);

      // The same report now opens the same line for both: the -40 carries
      // into the opening score instead of becoming a lifetime ban.
      await expect(scores.connect(underwriter).underwrite(stranger.address, await fresh(BEST)))
        .to.emit(scores, "Underwritten")
        .withArgs(stranger.address, 680, false, anyValue)
        .and.to.emit(scores, "ScoreChanged")
        .withArgs(stranger.address, 560, 680, "underwritten");
      expect(await scores.baseLimitOf(stranger.address)).to.equal(await scores.baseLimitOf(user.address));
      expect(await scores.baseLimitOf(stranger.address)).to.equal(AUSD(1_000));
      const p = await scores.profileOf(stranger.address);
      expect(p.latePayments).to.equal(1);
      expect(p.underwritten).to.equal(true);

      // And nothing is laundered: with a weaker report the penalty still
      // lands, 40 under what the report alone would open.
      const [, , , , , weak] = await ethers.getSigners();
      await ausd.mint(weak.address, AUSD(1_000));
      await ausd.connect(weak).approve(await vault.getAddress(), AUSD(1_000));
      await ausd.connect(weak).approve(await engine.getAddress(), AUSD(1_000));
      await vault.connect(weak).lock(AUSD(250));
      await borrow(weak, AUSD(200));
      await time.increaseTo((await engine.installmentDueAt(3n, 0)) + BigInt(GRACE) + 1n);
      await engine.connect(merchant).collectInstallment(3n);
      const report = await fresh({ ...HISTORY, priorLiquidations: 1 });
      expect((await scores.scoreFromFacts(report))[0]).to.equal(451n);
      await scores.connect(underwriter).underwrite(weak.address, report);
      expect(await scores.scoreOf(weak.address)).to.equal(411);
      expect(await scores.baseLimitOf(weak.address)).to.equal(AUSD(200));
    });

    it("a clean secured-path record opens no unsecured line until it is underwritten, then counts toward the opening score", async () => {
      await scores.setRequireUnderwriting(true);
      await vault.connect(stranger).lock(AUSD(250));
      await borrow(stranger, AUSD(200));
      await engine.connect(stranger).repay(1, await engine.installmentAmount(1));

      const before = await scores.profileOf(stranger.address);
      expect(before.score).to.equal(612);
      expect(before.initialized).to.equal(true);
      expect(before.underwritten).to.equal(false);
      expect(await scores.baseLimitOf(stranger.address)).to.equal(0n);

      // Paid off and the collateral taken back: nothing unsecured remains.
      await engine.connect(stranger).repay(1, await engine.outstandingOf(1));
      await vault.connect(stranger).withdraw(AUSD(250));
      expect(await scores.creditLimitOf(stranger.address)).to.equal(0n);
      await expect(borrow(stranger, AUSD(10))).to.be.revertedWithCustomError(
        engine,
        "ExceedsCreditLimit"
      );

      // The DON can still assess it. The least history opens at 526, and the
      // +12 the wallet earned is kept: the same 538 it would have had if the
      // report had come first.
      await expect(scores.connect(underwriter).underwrite(stranger.address, await fresh(HISTORY)))
        .to.emit(scores, "Underwritten")
        .withArgs(stranger.address, 538, false, anyValue)
        .and.to.emit(scores, "ScoreChanged")
        .withArgs(stranger.address, 612, 538, "underwritten");

      const after = await scores.profileOf(stranger.address);
      expect(after.underwritten).to.equal(true);
      // Both payments were on time and both are counted; the second, inside
      // a week of the first, moved no score.
      expect(after.onTimePayments).to.equal(2);
      expect(after.firstSeenAt).to.equal(before.firstSeenAt);
      expect(await scores.baseLimitOf(stranger.address)).to.equal(AUSD(200));
      await expect(borrow(stranger, AUSD(150))).to.not.be.reverted;

      // Once.
      await expect(
        scores.connect(underwriter).underwrite(stranger.address, await fresh(BEST))
      ).to.be.revertedWithCustomError(scores, "AlreadyHasRecord");
    });

    it("the DON's decline still applies to a wallet that repaid on the secured path first", async () => {
      await scores.setRequireUnderwriting(true);
      await vault.connect(stranger).lock(AUSD(250));
      await borrow(stranger, AUSD(200));
      await engine.connect(stranger).repay(1, await engine.installmentAmount(1));
      expect(await scores.scoreOf(stranger.address)).to.equal(612);

      // A 30-wallet cluster with two prior liquidations: 520 - 150 - 54 = 316,
      // plus the 12 earned, and declined.
      const damning = { priorLiquidations: 2, relatedWallets: 30 };
      await expect(
        scores.connect(underwriter).underwrite(stranger.address, await fresh(damning))
      )
        .to.emit(scores, "Underwritten")
        .withArgs(stranger.address, 328, true, anyValue);

      expect(await scores.baseLimitOf(stranger.address)).to.equal(0n);
      // The $250 still locked, at face value, and nothing unsecured on top.
      expect(await scores.creditLimitOf(stranger.address)).to.equal(AUSD(250));
    });

    it("secured-path history folded into a report still never opens a line above $1,000", async () => {
      await scores.setRequireUnderwriting(true);
      await vault.connect(stranger).lock(AUSD(250));
      await borrow(stranger, AUSD(200));

      // Two on-time instalments a fortnight apart: +24.
      await engine.connect(stranger).repay(1, await engine.installmentAmount(1));
      await time.increaseTo(await engine.installmentDueAt(1, 1));
      await engine.connect(merchant).collectInstallment(1);
      expect(await scores.scoreOf(stranger.address)).to.equal(624);

      // 720 from the facts plus 24 earned would be 744, the $2,500 tier.
      await expect(
        scores.connect(underwriter).underwrite(stranger.address, await fresh(BEST))
      )
        .to.emit(scores, "Underwritten")
        .withArgs(stranger.address, 739, false, anyValue);
      expect(await scores.baseLimitOf(stranger.address)).to.equal(AUSD(1_000));
    });

    it("with it off, behaviour is exactly as before", async () => {
      expect(await scores.requireUnderwriting()).to.equal(false);

      const check = async () => {
        expect(await scores.scoreOf(stranger.address)).to.equal(600);
        expect(await scores.baseLimitOf(stranger.address)).to.equal(AUSD(500));
        expect(await scores.creditLimitOf(stranger.address)).to.equal(AUSD(500));
        const p = await scores.profileOf(stranger.address);
        expect(p.initialized).to.equal(false);
        expect(p.declined).to.equal(false);
        expect(p.underwritten).to.equal(false);
      };

      await check();
      // Switching it on and off again leaves no trace.
      await scores.setRequireUnderwriting(true);
      await scores.setRequireUnderwriting(false);
      await check();
      await expect(borrow(stranger, AUSD(400))).to.not.be.reverted;
    });
  });

  describe("what a report cannot be turned into", () => {
    /// The cheapest plan that scores: $20, one hourly instalment, repaid at once.
    async function farm(who) {
      await engine.createLoan(who.address, merchant.address, AUSD(20), 1, HOUR);
      const id = await engine.loanCount();
      return engine.connect(who).repay(id, await engine.outstandingOf(id));
    }

    it("the $1,000 cap outlasts the report: a folded score at the top of the tier cannot cross into $2,500 the next transaction", async () => {
      await scores.setRequireUnderwriting(true);

      // One bonus earned on the secured path, a week before the report.
      await vault.connect(user).lock(AUSD(21));
      await farm(user);
      expect(await scores.scoreOf(user.address)).to.equal(612);
      await time.increase(BONUS_PERIOD);

      // The best facts plus the +12 folded in: 732, the $1,000 tier.
      await scores.connect(underwriter).underwrite(user.address, await fresh(BEST));
      expect(await scores.scoreOf(user.address)).to.equal(732);
      expect(await scores.lastBonusAt(user.address)).to.equal(BigInt(await time.latest()));

      // The reproduced attack: a $20 plan opened and repaid straight after the
      // report used to land 744 and the $2,500 tier. Every day of the first
      // week, it earns nothing.
      for (let day = 0; day < 7; day++) {
        await expect(farm(user)).to.emit(engine, "OnTimeBonusWithheld");
        expect(await scores.scoreOf(user.address)).to.equal(732);
        expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(1_000));
        await time.increase(DAY - 60);
      }

      // A full week after the report, the next bonus counts.
      await time.increaseTo((await scores.lastBonusAt(user.address)) + BigInt(BONUS_PERIOD));
      await farm(user);
      expect(await scores.scoreOf(user.address)).to.equal(744);
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(2_500));
    });

    it("from a report, each tier above $1,000 takes a week of repaying per bonus, however the plans are timed", async () => {
      await scores.connect(underwriter).underwrite(user.address, await fresh(BEST));
      const reportedAt = BigInt(await time.latest());
      expect(await scores.scoreOf(user.address)).to.equal(720);

      // Recycling the same $20 twice a week: only one of each pair counts,
      // the one a full week after the last bonus (or the report) counted.
      for (let week = 1; week <= 7; week++) {
        const nextAt = (await scores.lastBonusAt(user.address)) + BigInt(BONUS_PERIOD);
        await time.increaseTo(nextAt - BigInt(3 * DAY));
        await expect(farm(user)).to.emit(engine, "OnTimeBonusWithheld");
        await time.increaseTo(nextAt);
        await farm(user);
        expect(await scores.scoreOf(user.address), "week " + week).to.equal(720 + 12 * week);
        expect(await scores.baseLimitOf(user.address)).to.equal(
          week < 2 ? AUSD(1_000) : week < 7 ? AUSD(2_500) : AUSD(5_000)
        );
      }
      // 800 is seven bonuses from the report, so $5,000 took seven full weeks.
      expect(BigInt(await time.latest()) - reportedAt).to.be.greaterThanOrEqual(
        BigInt(7 * BONUS_PERIOD)
      );
    });

    it("with requireUnderwriting on, a never-underwritten wallet borrows against collateral at face value, so defaulting never pays", async () => {
      await scores.setRequireUnderwriting(true);
      const wallets = (await ethers.getSigners()).slice(10, 13);
      const merchantBefore = await ausd.balanceOf(merchant.address);
      let locked = 0n;

      for (const w of wallets) {
        await ausd.mint(w.address, AUSD(1_000));
        await ausd.connect(w).approve(await vault.getAddress(), AUSD(1_000));
        await ausd.connect(w).approve(await engine.getAddress(), AUSD(2_000));
        await vault.connect(w).lock(AUSD(1_000));
        locked += AUSD(1_000);

        // The multiplier still says 150%; nobody has assessed the extra half.
        expect(await vault.creditBoostOf(w.address)).to.equal(AUSD(1_500));
        expect(await scores.baseLimitOf(w.address)).to.equal(0n);
        expect(await scores.creditLimitOf(w.address)).to.equal(AUSD(1_000));

        // The reproduced attack borrowed $1,480 against $1,000.
        await expect(
          engine.createLoan(w.address, merchant.address, AUSD(1_480), 1, HOUR)
        ).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");

        // All it can do is borrow what it locked, and walk away.
        await engine.createLoan(w.address, merchant.address, AUSD(990), 1, HOUR);
        const id = await engine.loanCount();
        await ausd.connect(w).approve(await engine.getAddress(), 0);
        await time.increase(HOUR + GRACE + 1);
        await engine.connect(merchant).liquidate(id);
      }

      // Everything owed, interest included, came back out of the collateral.
      const received = (await ausd.balanceOf(merchant.address)) - merchantBefore;
      expect(received).to.equal(AUSD(2_970));
      expect(received).to.be.lessThan(locked);
      expect(await engine.badDebt()).to.equal(0n);
    });

    it("an underwritten wallet keeps the full multiplier on top of the line its report opened", async () => {
      await scores.setRequireUnderwriting(true);
      await scores.connect(underwriter).underwrite(user.address, await fresh(HISTORY));
      await vault.connect(user).lock(AUSD(100));
      expect(await scores.creditLimitOf(user.address)).to.equal(AUSD(200) + AUSD(150));
    });
  });

  describe("defaults on Polaris", () => {
    /// Borrow what the line allows, revoke the allowance, and be liquidated.
    async function defaultOnce(who, principal) {
      await ausd.connect(who).approve(await engine.getAddress(), AUSD(5_000));
      await engine.createLoan(who.address, merchant.address, principal, 1, HOUR);
      const id = await engine.loanCount();
      await ausd.connect(who).approve(await engine.getAddress(), 0);
      await time.increase(HOUR + GRACE + 1);
      return engine.connect(merchant).liquidate(id);
    }

    it("a wallet cannot default its $200 floor line again and again: its second liquidation here closes the line", async () => {
      await scores.setRequireUnderwriting(true);
      // The least history opens the $200 floor line, by design.
      await scores.connect(underwriter).underwrite(user.address, await fresh(HISTORY));
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(200));
      const walletStart = await ausd.balanceOf(user.address);

      await defaultOnce(user, AUSD(190));
      expect(await scores.scoreOf(user.address)).to.equal(376);
      // One default costs 150 points and leaves the floor line: people recover.
      expect(await scores.baseLimitOf(user.address)).to.equal(AUSD(200));

      // The second closes it, the same count that declines a report.
      await expect(defaultOnce(user, AUSD(190)))
        .to.emit(scores, "DeclinedForDefaults")
        .withArgs(user.address, 2);
      const p = await scores.profileOf(user.address);
      expect(p.liquidations).to.equal(2);
      expect(p.declined).to.equal(true);
      expect(p.underwritten).to.equal(true);
      expect(await scores.baseLimitOf(user.address)).to.equal(0n);

      // The loop is over: no third plan, and at most two floor lines lost.
      await ausd.connect(user).approve(await engine.getAddress(), AUSD(5_000));
      await expect(
        engine.createLoan(user.address, merchant.address, AUSD(10), 1, HOUR)
      ).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");
      expect(await engine.badDebt()).to.be.lessThan(AUSD(400));
      expect(await ausd.balanceOf(user.address)).to.equal(walletStart);

      // What the two facts would have said, the chain now says too.
      const [, wouldDecline] = await scores.scoreFromFacts(facts({ priorLiquidations: 2 }));
      expect(wouldDecline).to.equal(true);
      expect(await scores.DECLINE_AT_LIQUIDATIONS()).to.equal(2n);

      // Collateral still works, at face value, so every later default is covered.
      await vault.connect(user).lock(AUSD(100));
      expect(await scores.creditLimitOf(user.address)).to.equal(AUSD(100));
    });

    it("two liquidations close the line with underwriting off as well", async () => {
      expect(await scores.requireUnderwriting()).to.equal(false);
      await defaultOnce(stranger, AUSD(190));
      expect(await scores.baseLimitOf(stranger.address)).to.equal(AUSD(200));
      await defaultOnce(stranger, AUSD(190));
      expect(await scores.baseLimitOf(stranger.address)).to.equal(0n);
      expect(await scores.creditLimitOf(stranger.address)).to.equal(0n);
    });
  });
});
