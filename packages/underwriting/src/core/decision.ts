/**
 * The product decision: how much the buyer can spend, whether Pay in 4 is on
 * for this purchase, and what raises the line.
 *
 * Nothing here is a second opinion on the contract. The limit is
 * `ScoreManager.baseLimitOf` for the score, and a plan fits exactly when
 * `PolarisLoanEngine.createLoan` would accept it: activeDebt + principal +
 * interest <= creditLimitOf, with the engine's integer interest. So the app
 * never offers a plan the chain refuses, or hides one it would take.
 *
 * Cold start (plan §5.5) is handled here, not left to the UI: at the $200
 * floor a $200 purchase plus interest does not fit, so the decision says by
 * how much, and what setting that much aside would do.
 */

import { COLLATERAL_MULTIPLIER_BPS, LOAN, OPENING_CAP } from "./constants.ts";
import { formatDollars } from "./format.ts";
import { limitFor, nextTierFor, tierFor } from "./score.ts";
import type { AttestGap, CreditDecision, CreditReason, NextStep, PlanQuote } from "./types.ts";

/** `PolarisLoanEngine` interest: simple, pro-rated over the plan's length, rounded down. */
export function planInterest(principal: bigint, installments: number, intervalSeconds: number, aprBps: number = LOAN.INTEREST_RATE_BPS): bigint {
  const term = BigInt(installments) * BigInt(intervalSeconds);
  return (principal * BigInt(aprBps) * term) / (10_000n * BigInt(LOAN.YEAR_SECONDS));
}

/**
 * A plan as the engine will run it. Instalment k completes when the buyer has
 * repaid ceil(total * k / n); the last one completes at `total`. Each amount is
 * the step between two thresholds, so $200 over four weeks is
 * 50.383562 + 50.383561 + 50.383562 + 50.383561 = 201.534246.
 */
export function quotePlan(
  principal: bigint,
  installments: number = LOAN.PAY_IN_4_INSTALLMENTS,
  intervalSeconds: number = LOAN.PAY_IN_4_INTERVAL,
  aprBps: number = LOAN.INTEREST_RATE_BPS,
): PlanQuote {
  if (principal < 0n) throw new RangeError("principal must not be negative");
  if (!Number.isInteger(installments) || installments < 1 || installments > LOAN.MAX_INSTALLMENTS) {
    throw new RangeError(`installments must be 1..${LOAN.MAX_INSTALLMENTS}`);
  }
  const interest = planInterest(principal, installments, intervalSeconds, aprBps);
  const total = principal + interest;
  const n = BigInt(installments);
  const threshold = (k: bigint): bigint => (k >= n ? total : (total * k + n - 1n) / n);
  const amounts: bigint[] = [];
  for (let k = 1n; k <= n; k++) amounts.push(threshold(k) - threshold(k - 1n));
  return { principal, interest, total, installments, intervalSeconds, aprBps, amounts };
}

/** The largest principal whose total with interest fits `available`. */
export function maxPrincipal(
  available: bigint,
  installments: number = LOAN.PAY_IN_4_INSTALLMENTS,
  intervalSeconds: number = LOAN.PAY_IN_4_INTERVAL,
  aprBps: number = LOAN.INTEREST_RATE_BPS,
): bigint {
  if (available <= 0n) return 0n;
  let lo = 0n;
  let hi = available;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid + planInterest(mid, installments, intervalSeconds, aprBps) <= available) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** How much to lock in CollateralVault to cover `shortfall`, rounded up to the cent. */
export function collateralFor(shortfall: bigint, multiplierBps: number): bigint {
  if (shortfall <= 0n) return 0n;
  const raw = (shortfall * 10_000n + BigInt(multiplierBps) - 1n) / BigInt(multiplierBps);
  const cent = 10_000n;
  return ((raw + cent - 1n) / cent) * cent;
}

export interface DecideInput {
  score: number;
  declined: boolean;
  /** Plain-language decline reason. */
  declineReason?: string | null;
  /** What the buyer already owes on open plans (`activeDebtOf`). */
  activeDebt?: bigint;
  /** A purchase to quote, in base units. */
  purchase?: bigint | null;
  /** Extra line from collateral already locked (`creditBoostOf`). */
  collateralBoost?: bigint;
  reasons?: CreditReason[];
  /** The buyer already brought an outside history. */
  hasLinked?: boolean;
  /**
   * Why this is only a preview, if it is: the buyer still has to confirm the
   * linked wallet (`ownership`), a source has not answered yet (`checks`), or
   * a check needs a data provider this deployment has no key for
   * (`unavailable`: asking again does not help until it is set up).
   */
  pending?: "ownership" | "checks" | "unavailable" | null;
  /**
   * The facts are too thin for the DON to attest (attest.ts): nothing is
   * reported, so the account stays secured-only, as ScoreManager treats a
   * wallet not yet underwritten. Empty or null when they clear the floor.
   */
  thinFile?: readonly AttestGap[] | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Pay in 4 opens after 90 days of history and 10 payments and transfers." */
function thinReason(gaps: readonly AttestGap[]): string {
  const age = gaps.find((g) => g.fact === "walletAgeDays");
  const tx = gaps.find((g) => g.fact === "txCount");
  const parts = [
    age ? `${plural(age.need, "day", "days")} of history` : null,
    tx ? plural(tx.need, "payment or transfer", "payments and transfers") : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? `Pay in 4 opens after ${parts.join(" and ")}.` : "Pay in 4 opens once there's a little more history here.";
}

/** "Keep using Polaris: Pay in 4 opens in 87 days, once you've made 9 more payments and transfers." */
function buildHistoryStep(gaps: readonly AttestGap[]): NextStep {
  const age = gaps.find((g) => g.fact === "walletAgeDays");
  const tx = gaps.find((g) => g.fact === "txCount");
  const days = age ? `in ${plural(age.need - age.have, "day", "days")}` : null;
  const sends = tx ? plural(tx.need - tx.have, "more payment or transfer", "more payments and transfers") : null;
  const when = days && sends ? `${days}, once you've made ${sends}` : (days ?? (sends ? `after ${sends}` : "with a little more history"));
  return { id: "build-history", label: `Keep using Polaris: Pay in 4 opens ${when}.` };
}

export function decide(input: DecideInput): CreditDecision {
  const { score, declined } = input;
  const activeDebt = input.activeDebt ?? 0n;
  const boost = input.collateralBoost ?? 0n;
  const gaps = input.thinFile ?? [];
  // A thin file is never attested, so it has no unsecured line of its own. A decline is attested, thin or not.
  const thin = gaps.length > 0 && !declined;
  const securedOnly = declined || thin;
  const limit = thin ? 0n : limitFor(score, declined);
  const lineWithBoost = limit + boost;
  const available = lineWithBoost > activeDebt ? lineWithBoost - activeDebt : 0n;

  const installments = LOAN.PAY_IN_4_INSTALLMENTS;
  const intervalSeconds = LOAN.PAY_IN_4_INTERVAL;
  const aprBps = LOAN.INTEREST_RATE_BPS;
  const maxPurchase = maxPrincipal(available, installments, intervalSeconds, aprBps);

  let quote: CreditDecision["payIn4"]["quote"] = null;
  if (input.purchase != null && input.purchase > 0n) {
    const q = quotePlan(input.purchase, installments, intervalSeconds, aprBps);
    quote = { ...q, fits: q.total <= available };
  }

  // A declined or never-underwritten buyer keeps the secured path at face value (ScoreManager._securedOnly).
  const multiplierBps = securedOnly ? 10_000 : COLLATERAL_MULTIPLIER_BPS;

  let allowed = maxPurchase > 0n;
  let reason: string | null = null;
  if (declined && boost === 0n) {
    allowed = false;
    reason = input.declineReason ?? "We can't offer you credit right now.";
  } else if (thin && boost === 0n) {
    allowed = false;
    reason = thinReason(gaps);
  } else if (maxPurchase === 0n) {
    allowed = false;
    reason = limit > 0n ? "Your line is in use. It frees up as you pay." : "There's no credit available on this account yet.";
  } else if (quote && !quote.fits) {
    allowed = false;
    reason = `That's ${formatDollars(quote.total - available, { cents: true })} more than you can pay in 4 today. You can pay in 4 for up to ${formatDollars(maxPurchase, { cents: true })}.`;
  }

  const nextSteps: NextStep[] = [];
  if (input.pending === "checks") {
    nextSteps.push({ id: "retry", label: "We're finishing a check on your history. Try again in a minute." });
  }
  if (thin && !declined && !input.hasLinked && input.pending !== "ownership") {
    // The Bring your history step, so "wallet" is allowed: a real history clears the floor at once.
    nextSteps.push({ id: "link-history", label: "Open a line now: confirm with the wallet you already use." });
  }
  // Thin facts while a check can't run here may not be thin: no promise about when Pay in 4 opens.
  if (thin && !declined && input.pending !== "checks" && input.pending !== "unavailable") nextSteps.push(buildHistoryStep(gaps));
  // Confirming a linked wallet helps only when its history is what clears the floor.
  if (input.pending === "ownership" && !declined && !thin) {
    // "Wallet" is allowed only on the Bring your history step (plan §2, "Words the buyer never sees").
    nextSteps.push({ id: "link-history", label: "Confirm with the wallet you already use to count its history." });
  }
  if (quote && !quote.fits) {
    // Collateral adds lock × multiplier to the line (face value when secured-only).
    const lock = collateralFor(quote.total - available, multiplierBps);
    nextSteps.push({ id: "secure", label: `Set aside ${formatDollars(lock, { cents: true })} to pay in 4 for this purchase.` });
  }
  if (!securedOnly && !input.hasLinked && input.pending !== "ownership") {
    // The Bring your history step, so "wallet" is allowed here too.
    nextSteps.push({ id: "link-history", label: "Raise your limit: confirm with the wallet you already use." });
  }
  const next = securedOnly ? null : nextTierFor(score);
  if (next) {
    const weeks = next.onTimeWeeks;
    nextSteps.push({
      id: "repay",
      label: `Pay on time for ${weeks === 1 ? "a week" : `${weeks} weeks`} to reach a ${formatDollars(next.limit)} line.`,
    });
  }
  if (!quote || quote.fits) {
    nextSteps.push({
      id: "secure",
      label: securedOnly
        ? "Set money aside to pay in 4 against it."
        : `Set aside ${formatDollars(100_000_000n)} to add ${formatDollars((100_000_000n * BigInt(multiplierBps)) / 10_000n)} to your line.`,
    });
  }

  let headline: string;
  if (declined && boost === 0n) headline = "We can't offer you credit right now.";
  // Thin facts from a source that has not answered may not be thin: say only that a check is running.
  else if (thin && input.pending === "checks") headline = "We're finishing a check on your history.";
  else if (thin && input.pending === "unavailable") headline = "Credit reviews aren't fully set up here yet.";
  else if (thin && boost === 0n) headline = "Pay in 4 opens once there's a little more history here.";
  // Pending ownership is the Bring your history step: the buyer confirms with the wallet they linked.
  else if (input.pending === "ownership" && !thin) headline = `Confirm with your wallet to open a ${formatDollars(lineWithBoost)} line.`;
  else if (input.pending === "checks") headline = `Your line is ${formatDollars(lineWithBoost)} for now. We're finishing a check on your history.`;
  else if (input.pending === "unavailable") headline = `Your line is ${formatDollars(lineWithBoost)} for now. Credit reviews aren't fully set up here yet.`;
  else if (allowed) headline = `You can pay in 4 for up to ${formatDollars(maxPurchase, { cents: true })}.`;
  else if (quote && !quote.fits) headline = `Your line is ${formatDollars(lineWithBoost)}. This purchase needs a little more.`;
  else headline = `Your line is ${formatDollars(lineWithBoost)}.`;

  return {
    score,
    declined,
    declineReason: declined ? (input.declineReason ?? null) : null,
    limit,
    openingCap: OPENING_CAP,
    available,
    tier: tierFor(score),
    nextTier: next,
    payIn4: { allowed, installments, intervalSeconds, aprBps, maxPurchase, reason, quote },
    thinFile: thin ? gaps.map((g) => ({ ...g })) : null,
    headline,
    reasons: input.reasons ?? [],
    nextSteps,
  };
}
