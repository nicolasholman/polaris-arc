const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** $25,000.00 */
export function formatUsd(value: number): string {
  return usd.format(Math.max(0, value));
}

/** $25,000 */
export function formatUsdWhole(value: number): string {
  return usdWhole.format(Math.max(0, Math.round(value)));
}
