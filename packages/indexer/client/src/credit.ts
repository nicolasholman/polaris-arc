/**
 * ScoreManager.creditLimitOf, computed from an indexed Buyer and the
 * protocol's current settings. The indexer stores each buyer's limit as of
 * their last event; this applies a later settings change (the collateral
 * multiplier, requireUnderwriting) at once. A test keeps it equal to the
 * indexer's own copy in ../../src/lib/credit.ts.
 */

const USD = 1_000_000n;
const STARTING_SCORE = 600;

export type CreditInputs = {
  readonly score: number;
  readonly hasRecord: boolean;
  readonly declined: boolean;
  readonly underwritten: boolean;
  readonly collateral: bigint;
};

export type CreditSettings = {
  readonly requireUnderwriting: boolean;
  readonly collateralCountsTowardLimits: boolean;
  readonly collateralMultiplierBps: number;
};

export function securedOnly(b: CreditInputs, s: CreditSettings): boolean {
  return b.declined || (s.requireUnderwriting && !b.underwritten);
}

export function baseLimitOf(b: CreditInputs, s: CreditSettings): bigint {
  if (securedOnly(b, s)) return 0n;
  const score = b.hasRecord ? b.score : STARTING_SCORE;
  if (score >= 800) return 5_000n * USD;
  if (score >= 740) return 2_500n * USD;
  if (score >= 670) return 1_000n * USD;
  if (score >= 580) return 500n * USD;
  return 200n * USD;
}

export function creditLimitOf(b: CreditInputs, s: CreditSettings): bigint {
  const base = baseLimitOf(b, s);
  if (!s.collateralCountsTowardLimits) return base;
  let boost = (b.collateral * BigInt(s.collateralMultiplierBps)) / 10_000n;
  if (securedOnly(b, s) && boost > b.collateral) boost = b.collateral;
  return base + boost;
}

/** What the buyer can still spend on Pay in 4 right now. */
export function availableCredit(b: CreditInputs & { readonly activeDebt: bigint }, s: CreditSettings): bigint {
  const limit = creditLimitOf(b, s);
  return limit > b.activeDebt ? limit - b.activeDebt : 0n;
}
