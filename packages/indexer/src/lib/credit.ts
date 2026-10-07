/**
 * ScoreManager's credit line, mirrored: the score tier gives the base line,
 * locked collateral adds its value times the vault's multiplier, and a buyer
 * who defaulted twice or was never underwritten (while underwriting is
 * required) gets collateral only. Tested against ScoreManager.baseLimitOf and
 * creditLimitOf.
 */

export const STARTING_SCORE = 600;
export const USD = 1_000_000n;

export type CreditInputs = {
  readonly score: number;
  readonly hasRecord: boolean;
  readonly declined: boolean;
  readonly underwritten: boolean;
  readonly collateral: bigint;
};

export type CreditSettings = {
  readonly requireUnderwriting: boolean;
  /** ScoreManager has a CollateralVault: collateral raises limits. */
  readonly collateralCountsTowardLimits: boolean;
  readonly collateralMultiplierBps: number;
};

/** Collateral only: no unsecured line. (ScoreManager._securedOnly) */
export function securedOnly(b: CreditInputs, s: CreditSettings): boolean {
  return b.declined || (s.requireUnderwriting && !b.underwritten);
}

/** ScoreManager.baseLimitOf */
export function baseLimitOf(b: CreditInputs, s: CreditSettings): bigint {
  if (securedOnly(b, s)) return 0n;
  const score = b.hasRecord ? b.score : STARTING_SCORE;
  if (score >= 800) return 5_000n * USD;
  if (score >= 740) return 2_500n * USD;
  if (score >= 670) return 1_000n * USD;
  if (score >= 580) return 500n * USD;
  return 200n * USD;
}

/** ScoreManager.creditLimitOf */
export function creditLimitOf(b: CreditInputs, s: CreditSettings): bigint {
  const base = baseLimitOf(b, s);
  if (!s.collateralCountsTowardLimits) return base;
  let boost = (b.collateral * BigInt(s.collateralMultiplierBps)) / 10_000n;
  if (securedOnly(b, s) && boost > b.collateral) boost = b.collateral;
  return base + boost;
}
