/**
 * AUSD amounts. The indexer keeps base units (6 decimals); the dashboard
 * works in integer US cents (apps/business/src/lib/data/types.ts). Convert
 * here, once, and never do float maths on a balance.
 */

export const AUSD_DECIMALS = 6;
const UNITS_PER_CENT = 10_000n;

/** Base units to integer cents, rounding half away from zero. */
export function toCents(units: bigint): number {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = (abs + UNITS_PER_CENT / 2n) / UNITS_PER_CENT;
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${units} units is too large for cents`);
  return negative ? -n : n;
}

/** Integer cents to base units. */
export function fromCents(cents: number): bigint {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`${cents} is not a whole number of cents`);
  return BigInt(cents) * UNITS_PER_CENT;
}

/** "$1,234.56" (rounded to the cent). */
export function formatUsd(units: bigint): string {
  const cents = toCents(units);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * A USD decimal string with 2 to 6 decimals, the way webhooks carry amounts
 * (polarispay-sdk's documented format, and exactly what the API writes):
 * 25000000 is "25.00", 201534246 is "201.534246", 1000050 is "1.00005".
 */
export function formatAmount(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(AUSD_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${sign}${whole}.${frac}`;
}
