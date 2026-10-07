/**
 * The score is ScoreManager's, not ours. These hold the TypeScript mirror to
 * the hand-computed table in packages/contracts/test/metropolis/Underwrite.test.js
 * and, across a seeded sweep, to the JavaScript mirror that suite holds to the
 * contract. TS == JS == Solidity, so the app can never show a limit the chain
 * will not give.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { OPENING_CAP, SCORE, TIERS, U16_MAX, U32_MAX, U64_MAX } from "../src/core/constants.ts";
import { limitFor, nextTierFor, scoreBreakdown, scoreFromFacts, tierFor } from "../src/core/score.ts";
import type { Facts } from "../src/core/types.ts";

const require = createRequire(import.meta.url);
const jsMirror = require("../../contracts/test/helpers/underwrite-mirror.js") as {
  scoreFromFacts: (f: object) => { score: number; declined: boolean };
  UNDERWRITE_FLOOR: bigint;
  MIN_SCORE: bigint;
  MAX_UNDERWRITTEN_SCORE: bigint;
  MAX_AGE_POINTS: bigint;
  MAX_ACTIVITY_POINTS: bigint;
  MAX_BALANCE_POINTS: bigint;
  MAX_DEFI_POINTS: bigint;
  EXCHANGE_FUNDED_POINTS: bigint;
};

const AUSD = (n: number) => BigInt(Math.round(n * 1e6));
const EMPTY: Facts = {
  walletAgeDays: 0,
  txCount: 0,
  stableBalance: 0n,
  defiTenureDays: 0,
  priorLiquidations: 0,
  relatedWallets: 0,
  exchangeFunded: false,
  observedAt: 0n,
};
const BEST: Partial<Facts> = {
  walletAgeDays: 900,
  txCount: 1250,
  stableBalance: AUSD(5_000),
  defiTenureDays: 900,
  exchangeFunded: true,
};
const f = (o: Partial<Facts> = {}): Facts => ({ ...EMPTY, ...o });

// Copied from Underwrite.test.js, which works each row by hand from the specification.
const VECTORS: Array<{ name: string; f: Partial<Facts>; score: number; declined: boolean }> = [
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
    f: { walletAgeDays: 200, txCount: 300, stableBalance: AUSD(1_234.56), defiTenureDays: 61, relatedWallets: 5 },
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

/** The same generator the contract suite uses, so a failure reproduces. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("scoreFromFacts mirrors ScoreManager", () => {
  for (const v of VECTORS) {
    it(v.name, () => {
      assert.deepEqual(scoreFromFacts(f(v.f)), { score: v.score, declined: v.declined });
      assert.deepEqual(jsMirror.scoreFromFacts(f(v.f)), { score: v.score, declined: v.declined });
    });
  }

  it("agrees with the contract-held JS mirror across 5,000 seeded facts that straddle every threshold", () => {
    const rand = mulberry32(0x5eed);
    const pick = (max: number) => Math.floor(rand() * (max + 1));
    for (let i = 0; i < 5_000; i++) {
      const facts = f({
        walletAgeDays: pick(1_000),
        txCount: pick(1_400),
        stableBalance: BigInt(pick(6_000)) * 1_000_000n + BigInt(pick(999_999)),
        defiTenureDays: pick(1_000),
        priorLiquidations: pick(3),
        relatedWallets: pick(70),
        exchangeFunded: rand() < 0.5,
      });
      assert.deepEqual(scoreFromFacts(facts), jsMirror.scoreFromFacts(facts), JSON.stringify(facts, (_, x) => (typeof x === "bigint" ? `${x}` : x)));
    }
  });

  it("uses the contract's constants", () => {
    assert.equal(BigInt(SCORE.UNDERWRITE_FLOOR), jsMirror.UNDERWRITE_FLOOR);
    assert.equal(BigInt(SCORE.MIN), jsMirror.MIN_SCORE);
    assert.equal(BigInt(SCORE.MAX_UNDERWRITTEN), jsMirror.MAX_UNDERWRITTEN_SCORE);
    assert.equal(BigInt(SCORE.MAX_AGE_POINTS), jsMirror.MAX_AGE_POINTS);
    assert.equal(BigInt(SCORE.MAX_ACTIVITY_POINTS), jsMirror.MAX_ACTIVITY_POINTS);
    assert.equal(BigInt(SCORE.MAX_BALANCE_POINTS), jsMirror.MAX_BALANCE_POINTS);
    assert.equal(BigInt(SCORE.MAX_DEFI_POINTS), jsMirror.MAX_DEFI_POINTS);
    assert.equal(BigInt(SCORE.EXCHANGE_FUNDED_POINTS), jsMirror.EXCHANGE_FUNDED_POINTS);
  });
});

describe("the breakdown", () => {
  it("adds up to the unclamped score, term by term", () => {
    const b = scoreBreakdown(f({ walletAgeDays: 730, txCount: 300, stableBalance: AUSD(1_240), defiTenureDays: 400, exchangeFunded: true, relatedWallets: 6, priorLiquidations: 1 }));
    assert.equal(b.age, 48, "two years is 24 whole months, doubled");
    assert.equal(b.activity, 12);
    assert.equal(b.balance, 12);
    assert.equal(b.defi, 13);
    assert.equal(b.exchange, 10);
    assert.equal(b.cluster, -6);
    assert.equal(b.liquidations, -75);
    assert.equal(b.raw, 520 + 48 + 12 + 12 + 13 + 10 - 6 - 75);
    assert.equal(b.score, b.raw);
    assert.equal(b.clamped, false);
  });

  it("says when the clamp, not the terms, set the score", () => {
    const b = scoreBreakdown(f({ priorLiquidations: 5 }));
    assert.equal(b.score, 300);
    assert.equal(b.clamped, true);
    assert.deepEqual(b.declinedFor, ["liquidations"]);
  });

  it("names both reasons when both decline", () => {
    assert.deepEqual(scoreBreakdown(f({ priorLiquidations: 2, relatedWallets: 30 })).declinedFor, ["liquidations", "cluster"]);
  });
});

describe("limits", () => {
  it("reads ScoreManager.baseLimitOf's tiers", () => {
    assert.equal(tierFor(300).limit, 200_000_000n);
    assert.equal(tierFor(579).limit, 200_000_000n);
    assert.equal(tierFor(580).limit, 500_000_000n);
    assert.equal(tierFor(669).limit, 500_000_000n);
    assert.equal(tierFor(670).limit, 1_000_000_000n);
    assert.equal(tierFor(740).limit, 2_500_000_000n);
    assert.equal(tierFor(800).limit, 5_000_000_000n);
    assert.equal(tierFor(850).limit, 5_000_000_000n);
  });

  it("never opens an underwritten line above $1,000, whatever the facts", () => {
    const top = scoreFromFacts(f(BEST));
    assert.ok(limitFor(top.score, top.declined) <= OPENING_CAP);
    assert.equal(tierFor(SCORE.MAX_UNDERWRITTEN).limit, OPENING_CAP);
  });

  it("is zero when declined", () => {
    assert.equal(limitFor(700, true), 0n);
  });

  it("counts the on-time weeks to the next tier, one bonus a week", () => {
    assert.deepEqual(nextTierFor(520), { minScore: 580, limit: 500_000_000n, pointsNeeded: 60, onTimeWeeks: 5 });
    assert.deepEqual(nextTierFor(692), { minScore: 740, limit: 2_500_000_000n, pointsNeeded: 48, onTimeWeeks: 4 });
    assert.equal(nextTierFor(800), null);
    assert.equal(TIERS[0]!.minScore, 800);
  });
});
