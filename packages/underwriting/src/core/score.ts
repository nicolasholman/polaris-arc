/**
 * `ScoreManager.scoreFromFacts`, mirrored line for line, with the breakdown
 * the contract computes but does not return.
 *
 * BigInt throughout, with the contract's integer division and order of
 * operations: `(walletAgeDays / 30) * 2` rounds to whole months before
 * doubling, so a mirror that doubled first would disagree on every odd month.
 *
 *   520 + min(age/30*2, 60) + min(tx/25, 50) + min(balance/$100, 50)
 *       + min(defi/30, 30) + (exchangeFunded ? 10 : 0)
 *       - 75*liquidations - min((related-3)*2, 80) when related > 3
 *   clamped to [300, 739]; declined at liquidations >= 2 or related >= 25.
 */

import { SCORE, TIERS } from "./constants.ts";
import type { Facts } from "./types.ts";

export interface ScoreBreakdown {
  floor: number;
  age: number;
  activity: number;
  balance: number;
  defi: number;
  exchange: number;
  /** Negative or zero. */
  liquidations: number;
  /** Negative or zero. */
  cluster: number;
  /** floor + every term, before clamping. */
  raw: number;
  score: number;
  declined: boolean;
  declinedFor: Array<"liquidations" | "cluster">;
  /** True when the clamp, not the terms, set the score. */
  clamped: boolean;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

type FactsLike = Omit<Facts, "observedAt"> & { observedAt?: bigint };

export function scoreBreakdown(f: FactsLike): ScoreBreakdown {
  const age = min((BigInt(f.walletAgeDays) / 30n) * 2n, BigInt(SCORE.MAX_AGE_POINTS));
  const activity = min(BigInt(f.txCount) / 25n, BigInt(SCORE.MAX_ACTIVITY_POINTS));
  const balance = min(BigInt(f.stableBalance) / 100_000_000n, BigInt(SCORE.MAX_BALANCE_POINTS));
  const defi = min(BigInt(f.defiTenureDays) / 30n, BigInt(SCORE.MAX_DEFI_POINTS));
  const exchange = f.exchangeFunded ? BigInt(SCORE.EXCHANGE_FUNDED_POINTS) : 0n;

  const related = BigInt(f.relatedWallets);
  const free = BigInt(SCORE.CLUSTER_FREE);
  const cluster =
    related > free
      ? min((related - free) * BigInt(SCORE.CLUSTER_POINTS_PER_WALLET), BigInt(SCORE.MAX_CLUSTER_PENALTY))
      : 0n;
  const liquidationCount = BigInt(f.priorLiquidations);
  const liquidations = liquidationCount * BigInt(SCORE.LIQUIDATION_PENALTY);

  const floor = BigInt(SCORE.UNDERWRITE_FLOOR);
  const raw = floor + age + activity + balance + defi + exchange - liquidations - cluster;
  let score = raw;
  if (score < BigInt(SCORE.MIN)) score = BigInt(SCORE.MIN);
  if (score > BigInt(SCORE.MAX_UNDERWRITTEN)) score = BigInt(SCORE.MAX_UNDERWRITTEN);

  const declinedFor: ScoreBreakdown["declinedFor"] = [];
  if (liquidationCount >= BigInt(SCORE.DECLINE_AT_LIQUIDATIONS)) declinedFor.push("liquidations");
  if (related >= BigInt(SCORE.DECLINE_AT_RELATED)) declinedFor.push("cluster");

  return {
    floor: Number(floor),
    age: Number(age),
    activity: Number(activity),
    balance: Number(balance),
    defi: Number(defi),
    exchange: Number(exchange),
    liquidations: -Number(liquidations),
    cluster: -Number(cluster),
    raw: Number(raw),
    score: Number(score),
    declined: declinedFor.length > 0,
    declinedFor,
    clamped: score !== raw,
  };
}

/** Exactly what `ScoreManager.scoreFromFacts` returns. */
export function scoreFromFacts(f: FactsLike): { score: number; declined: boolean } {
  const b = scoreBreakdown(f);
  return { score: b.score, declined: b.declined };
}

/** `ScoreManager.baseLimitOf` for a wallet with a line: the tier the score reads as. */
export function tierFor(score: number): { minScore: number; limit: bigint } {
  for (const tier of TIERS) if (score >= tier.minScore) return tier;
  return TIERS[TIERS.length - 1]!;
}

/** The unsecured limit a score opens, or 0 when declined. */
export function limitFor(score: number, declined: boolean): bigint {
  return declined ? 0n : tierFor(score).limit;
}

/** The tier above `score`, and what reaching it takes by repaying on time. */
export function nextTierFor(
  score: number,
): { minScore: number; limit: bigint; pointsNeeded: number; onTimeWeeks: number } | null {
  let next: { minScore: number; limit: bigint } | null = null;
  for (const tier of TIERS) if (tier.minScore > score) next = tier;
  if (!next) return null;
  const pointsNeeded = next.minScore - score;
  // One bonus per BONUS_PERIOD (a week), whatever the number of plans.
  const onTimeWeeks = Math.ceil(pointsNeeded / SCORE.ON_TIME_BONUS);
  return { ...next, pointsNeeded, onTimeWeeks };
}
