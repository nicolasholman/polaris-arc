/**
 * PolarisLoanEngine's instalment ladder, for building a plan's schedule from
 * an indexed row. A test keeps it equal to the indexer's own copy in
 * ../../src/lib/loans.ts.
 */

/** What must have been repaid for `k` instalments to be complete: ceil(totalOwed·k/n), exactly totalOwed at k >= n. */
export function thresholdFor(totalOwed: bigint, installmentCount: number, k: number): bigint {
  if (k <= 0) return 0n;
  if (k >= installmentCount) return totalOwed;
  const n = BigInt(installmentCount);
  return (totalOwed * BigInt(k) + n - 1n) / n;
}

/** Instalment `index`'s own amount (0-based). */
export function installmentSlice(totalOwed: bigint, installmentCount: number, index: number): bigint {
  return thresholdFor(totalOwed, installmentCount, index + 1) - thresholdFor(totalOwed, installmentCount, index);
}
