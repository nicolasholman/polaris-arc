import type { Micros } from "../money";
import type { PlanOffer } from "./types";

export const DAY = 86_400;
export const WEEK = 7 * DAY;
export const YEAR = 365 * DAY;

/**
 * Pay in 4 pricing: simple interest at `aprBps`, pro-rated over the plan's
 * length, in integer base units like the loan engine. $200 at 10% over four
 * weekly instalments is $1.53 of interest: 4 × $50.38.
 *
 * The amounts follow the engine's ladder (`PolarisLoanEngine.thresholdFor`):
 * after k payments the buyer has paid ceil(total × k / n), so payment k is
 * ceil(total × (k+1) / n) − ceil(total × k / n), and the cents on screen never
 * drift from `installmentAmount()`.
 *
 * Nothing is charged when the plan opens. Payment k falls due one interval
 * after the one before it, the first one interval after opening
 * (`installmentDueAt(i) = startedAt + (i + 1) × interval`): see `dueAt`.
 */
export function quotePlan(principal: Micros, installments: number, interval: number, aprBps: number): PlanOffer {
  const n = BigInt(installments);
  const interest = (principal * BigInt(aprBps) * n * BigInt(interval)) / (10_000n * BigInt(YEAR));
  const total = principal + interest;
  const threshold = (k: bigint) => (k >= n ? total : (total * k + n - 1n) / n);
  const amounts = Array.from({ length: installments }, (_, i) => threshold(BigInt(i + 1)) - threshold(BigInt(i)));
  return { installments, interval, aprBps, amounts, total, interest };
}

/** When payment `index` (from 0) of a plan opened at `openedAt` (ms) is due, in ms. */
export function dueAt(openedAt: number, interval: number, index: number): number {
  return openedAt + (index + 1) * interval * 1000;
}

/** "every week", "every 2 weeks", "every month". */
export function describeInterval(seconds: number): string {
  if (seconds % (30 * DAY) === 0) {
    const months = seconds / (30 * DAY);
    return months === 1 ? "every month" : `every ${months} months`;
  }
  if (seconds % WEEK === 0) {
    const weeks = seconds / WEEK;
    return weeks === 1 ? "every week" : `every ${weeks} weeks`;
  }
  if (seconds % DAY === 0) {
    const days = seconds / DAY;
    return days === 1 ? "every day" : `every ${days} days`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

/** "a week", "2 weeks", "a month": for "Next payment in a week." */
export function describeDuration(seconds: number): string {
  if (seconds % (30 * DAY) === 0) {
    const months = seconds / (30 * DAY);
    return months === 1 ? "a month" : `${months} months`;
  }
  if (seconds % WEEK === 0) {
    const weeks = seconds / WEEK;
    return weeks === 1 ? "a week" : `${weeks} weeks`;
  }
  const days = Math.max(1, Math.round(seconds / DAY));
  return days === 1 ? "a day" : `${days} days`;
}
