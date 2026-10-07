/**
 * Score explanations: why a line is what it is, in the buyer's words.
 *
 * This file used to mirror the Solana program's weights over a Solana
 * `Evidence` type. On Monad the score is `ScoreManager.scoreFromFacts`, and
 * `@polarispay/underwriting` mirrors it line for line (held to the contract by
 * the Hardhat suite), so this module no longer keeps weights of its own: two
 * mirrors of one formula is how an app ends up showing a limit the chain will
 * not give. What stays here is the gateway's small, string-shaped API over it.
 *
 *   explain(facts)  →  ["You've used this account for 2 years · +48", ...]
 */

import {
  explainOnChainFacts,
  formatDollars,
  scoreBreakdown,
  tierFor,
  type CreditDecision,
  type Facts,
  type ScoreBreakdown,
} from "@polarispay/underwriting/core";

export type Band = {
  score: number;
  declined: boolean;
  /** Unsecured limit, 6-decimal base units. 0 when declined. */
  limit: bigint;
  breakdown: ScoreBreakdown;
};

/** The score and limit ScoreManager computes for these facts. */
export function scoreFrom(facts: Facts): Band {
  const breakdown = scoreBreakdown(facts);
  return {
    score: breakdown.score,
    declined: breakdown.declined,
    limit: breakdown.declined ? 0n : tierFor(breakdown.score).limit,
    breakdown,
  };
}

/** `ScoreManager.baseLimitOf`'s tiers, in base units. */
export function baseLimit(score: number): bigint {
  return tierFor(score).limit;
}

/** Every line that moved the score, ready to render: "… · +48". */
export function explain(facts: Facts, opts: { hasLinked?: boolean } = {}): string[] {
  return explainOnChainFacts(facts, opts).decision.reasons.map((r) => r.text);
}

/** The full decision (limit, Pay in 4, next steps) for facts already on chain. */
export function decisionFor(facts: Facts, opts: { activeDebt?: bigint; purchase?: bigint | null; hasLinked?: boolean } = {}): CreditDecision {
  return explainOnChainFacts(facts, opts).decision;
}

/** 1_240_000_000n → "$1,240". */
export function formatUnits(raw: bigint): string {
  return formatDollars(raw);
}
