/**
 * Money conversions. AUSD has 6 decimals; merchants price in cents. Every
 * conversion is exact integer arithmetic: nothing here touches a float.
 */

export const AUSD_DECIMALS = 6;
export const UNITS_PER_CENT = 10_000n;

export function centsToUnits(cents: number | bigint): bigint {
  return BigInt(cents) * UNITS_PER_CENT;
}

/** Whole cents, rounding down (only used for display of on-chain amounts). */
export function unitsToCents(units: bigint | string): number {
  return Number(BigInt(units) / UNITS_PER_CENT);
}

/**
 * Cents rounded half up, as the buyer is quoted a plan's total (polarispay-sdk
 * quotePayIn4, the app, the shop): 351.677260 is $351.68 everywhere. Balances
 * keep `unitsToCents`, which never shows more than is there.
 */
export function unitsToCentsRounded(units: bigint | string): number {
  return Number((BigInt(units) + UNITS_PER_CENT / 2n) / UNITS_PER_CENT);
}

/** "200.00" from 20000 cents. */
export function formatCents(cents: number | bigint): string {
  const c = BigInt(cents);
  const sign = c < 0n ? "-" : "";
  const abs = c < 0n ? -c : c;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * A USD decimal string with up to 6 decimals, never fewer than 2:
 * 201534246 → "201.534246", 25000000 → "25.00". This is how webhooks carry
 * amounts (the SDK's documented format).
 */
export function formatUnits(units: bigint | string): string {
  const u = BigInt(units);
  const sign = u < 0n ? "-" : "";
  const abs = u < 0n ? -u : u;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${sign}${whole}.${frac}`;
}

/** Parse "200", "200.5", "200.00" (or a number) to cents; null when it isn't a price. */
export function parseCents(value: unknown): number | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = value.toFixed(2);
    if (Math.abs(Number(text) - value) > 1e-9) return null;
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * The loan engine's instalment ladder: instalment k (1-based) is due when
 * repaid reaches ceil(totalOwed·k/n), so the amounts differ by at most one
 * base unit. Mirrors PolarisLoanEngine.thresholdFor exactly.
 */
export function thresholdFor(totalOwed: bigint, installments: number, k: number): bigint {
  if (k <= 0) return 0n;
  if (k >= installments) return totalOwed;
  const n = BigInt(installments);
  return (totalOwed * BigInt(k) + n - 1n) / n;
}

export function installmentAmounts(totalOwed: bigint, installments: number): bigint[] {
  return Array.from({ length: installments }, (_, i) => thresholdFor(totalOwed, installments, i + 1) - thresholdFor(totalOwed, installments, i));
}

/**
 * Pro-rated simple interest, as PolarisLoanEngine prices a plan: 10% APR over
 * installments·interval seconds. $200 over four weeks is $1.534246.
 */
export function quotePlanLocally(principal: bigint, installments: number, intervalSeconds: number, aprBps = 1000): { interest: bigint; total: bigint } {
  const term = BigInt(installments) * BigInt(intervalSeconds);
  const interest = (principal * BigInt(aprBps) * term) / (10_000n * 365n * 86_400n);
  return { interest, total: principal + interest };
}
