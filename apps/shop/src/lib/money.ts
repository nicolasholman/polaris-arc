/** Integer cents in the store; decimal strings ("349.00") at the Polaris boundary. */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD_WHOLE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** "$349.00". */
export function formatUsd(cents: number): string {
  return USD.format(cents / 100);
}

/** "$349" when there are no cents, "$87.25" otherwise: for prices on product tiles. */
export function formatPrice(cents: number): string {
  return cents % 100 === 0 ? USD_WHOLE.format(cents / 100) : USD.format(cents / 100);
}

/** 34900 → "349.00". */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`Not a whole number of cents: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "349.00" → 34900. Returns null for anything that isn't a two-decimal amount. */
export function decimalToCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole = "0", fraction = ""] = value.trim().split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
