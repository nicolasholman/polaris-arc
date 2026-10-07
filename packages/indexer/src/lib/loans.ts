/**
 * PolarisLoanEngine's schedule arithmetic, mirrored exactly so the indexer
 * never needs an eth_call. Tested against the contract's own numbers ($200 in
 * 4 weekly instalments = 201534246 owed, 50383562 first instalment).
 */

/**
 * Cumulative amount that must have been repaid for `k` instalments to count
 * as complete: ceil(totalOwed * k / n), and exactly totalOwed at k >= n.
 * (PolarisLoanEngine.thresholdFor)
 */
export function thresholdFor(totalOwed: bigint, installmentCount: number, k: number): bigint {
  if (k <= 0) return 0n;
  if (k >= installmentCount) return totalOwed;
  const n = BigInt(installmentCount);
  return (totalOwed * BigInt(k) + n - 1n) / n;
}

/** Instalment `index`'s own slice of what is owed (0-based). */
export function installmentSlice(totalOwed: bigint, installmentCount: number, index: number): bigint {
  return thresholdFor(totalOwed, installmentCount, index + 1) - thresholdFor(totalOwed, installmentCount, index);
}

/** How many instalments `totalRepaid` fully covers. (PolarisLoanEngine.installmentsEarned) */
export function installmentsEarned(totalOwed: bigint, installmentCount: number, totalRepaid: bigint): number {
  let k = 0;
  while (k < installmentCount && totalRepaid >= thresholdFor(totalOwed, installmentCount, k + 1)) k++;
  return k;
}

/** What has been paid toward instalment `index`, given everything repaid. */
export function paidToward(totalOwed: bigint, installmentCount: number, index: number, totalRepaid: bigint): bigint {
  const from = thresholdFor(totalOwed, installmentCount, index);
  const to = thresholdFor(totalOwed, installmentCount, index + 1);
  if (totalRepaid <= from) return 0n;
  return (totalRepaid < to ? totalRepaid : to) - from;
}

/** Interest a plan accrues (PolarisLoanEngine.createLoan): 10% APR pro-rated over the term. */
export const INTEREST_RATE_BPS = 1000n;
export function interestFor(principal: bigint, installmentCount: number, intervalSeconds: number): bigint {
  const term = BigInt(installmentCount) * BigInt(intervalSeconds);
  return (principal * INTEREST_RATE_BPS * term) / (10_000n * 365n * 86_400n);
}

/** When instalment `index` (0-based) falls due: firstDueAt + index * interval. */
export function dueAt(firstDueAt: number, intervalSeconds: number, index: number): number {
  return firstDueAt + index * intervalSeconds;
}

/**
 * The next collection attempt after `failedAttempts` failures, along the
 * dunning ladder, never later than the moment the plan becomes liquidatable
 * (at which point the workflow liquidates instead).
 */
export function nextAttemptAfterFailure(
  failedAt: number,
  failedAttempts: number,
  ladderSeconds: readonly number[],
  cap: number | undefined,
): number {
  const step = ladderSeconds.length === 0 ? 0 : ladderSeconds[Math.min(failedAttempts, ladderSeconds.length) - 1] ?? 0;
  const next = failedAt + step;
  return cap === undefined ? next : Math.min(next, cap);
}
