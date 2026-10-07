/** Formatting shared by Money, the charts and the gallery. */

export type MoneyParts = {
  /** A true minus (U+2212), like the chips, not a hyphen. */
  sign: "" | "−" | "+";
  symbol: string;
  integer: string;
  /** The decimal separator and the fraction ("" when there are no decimals). */
  fraction: string;
  /** "K", "M", "B" for compact values. */
  suffix: string;
};

const SYMBOLS: Record<string, string> = {
  USD: "$",
  AUSD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  NGN: "₦",
  MXN: "$",
  BRL: "R$",
};

export function currencySymbol(currency = "USD"): string {
  return SYMBOLS[currency.toUpperCase()] ?? "$";
}

/**
 * Split a dollar amount into the parts Money renders. `decimals` defaults to
 * 2; `compact` turns 37,847 into 37.8K.
 */
export function moneyParts(
  value: number,
  {
    currency = "USD",
    decimals = 2,
    signed = false,
    compact = false,
  }: { currency?: string; decimals?: number; signed?: boolean; compact?: boolean } = {},
): MoneyParts {
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  let scaled = abs;
  let suffix = "";
  if (compact) {
    if (abs >= 1e9) [scaled, suffix] = [abs / 1e9, "B"];
    else if (abs >= 1e6) [scaled, suffix] = [abs / 1e6, "M"];
    else if (abs >= 1e3) [scaled, suffix] = [abs / 1e3, "K"];
  }
  const digits = compact && suffix ? Math.min(decimals, 1) : decimals;
  const fixed = scaled.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const dot = fixed.indexOf(".");
  const integer = dot === -1 ? fixed : fixed.slice(0, dot);
  const fraction = dot === -1 ? "" : fixed.slice(dot);
  const sign = negative && abs > 0 ? "−" : signed && abs > 0 ? "+" : "";
  return { sign, symbol: currencySymbol(currency), integer, fraction, suffix };
}

/** "$1,284.50", "−$15.00", "+$2.1K". */
export function formatMoney(
  value: number,
  options?: { currency?: string; decimals?: number; signed?: boolean; compact?: boolean },
): string {
  const p = moneyParts(value, options);
  return `${p.sign}${p.symbol}${p.integer}${p.fraction}${p.suffix}`;
}

/** "+2.10%" / "-6.34%". */
export function formatPercent(value: number, { decimals = 2, signed = true } = {}): string {
  const s = Math.abs(value).toFixed(decimals);
  const sign = value > 0 && signed ? "+" : value < 0 ? "-" : "";
  return `${sign}${s}%`;
}

/** 40000 → "40K", 1250000 → "1.3M", 820 → "820". */
export function formatCompact(value: number, decimals = 1): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const fmt = (n: number, s: string) => `${sign}${Number(n.toFixed(decimals)).toString()}${s}`;
  if (abs >= 1e9) return fmt(abs / 1e9, "B");
  if (abs >= 1e6) return fmt(abs / 1e6, "M");
  if (abs >= 1e3) return fmt(abs / 1e3, "K");
  return `${sign}${Number(abs.toFixed(decimals)).toString()}`;
}

/** Group a typed amount ("1500.5") for display ("1,500.5"), keeping what was typed after the point. */
export function groupTyped(raw: string): string {
  const [int = "", frac] = raw.split(".");
  const grouped = (int.replace(/^0+(?=\d)/, "") || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
