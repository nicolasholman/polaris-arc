/**
 * Dollars, as the buyer sees them.
 *
 * Amounts travel as bigint base units of the dollar token (6 decimals), the
 * same integers the contracts use, and become text only here. The buyer never
 * sees a token name: everything is "$".
 */

import { FX_CURRENCIES, hasFxFeed } from "@polaris/fx/feeds";

export type Micros = bigint;

export const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

export function dollars(value: number): Micros {
  return BigInt(Math.round(value * 1e6));
}

export function toNumber(micros: Micros): number {
  return Number(micros) / 1e6;
}

const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Rounds half up to the cent, in integers, so $50.385 never shows as $50.38. */
function roundToCents(micros: Micros): Micros {
  const cent = UNIT / 100n;
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const rounded = ((abs + cent / 2n) / cent) * cent;
  return negative ? -rounded : rounded;
}

/**
 * "$1,284.50". With `trim`, whole amounts drop the cents: "$50", as a person
 * would say it. Balances keep them.
 */
export function usd(micros: Micros, opts: { trim?: boolean; sign?: boolean } = {}): string {
  const rounded = roundToCents(micros);
  const abs = rounded < 0n ? -rounded : rounded;
  const whole = abs % UNIT === 0n;
  const text = (opts.trim && whole ? usdWhole : usdCents).format(toNumber(abs));
  if (opts.sign) return `${rounded < 0n ? "−" : "+"} ${text}`;
  return rounded < 0n ? `−${text}` : text;
}

/** Splits "$1,284.50" into "$1,284" and ".50" so the cents can sit quieter. */
export function usdParts(micros: Micros): { whole: string; cents: string } {
  const text = usd(micros);
  const dot = text.lastIndexOf(".");
  return dot === -1 ? { whole: text, cents: "" } : { whole: text.slice(0, dot), cents: text.slice(dot) };
}

/**
 * Keypad text ("50", "12.5", "0.99") to base units. Returns null for anything
 * that is not a plain decimal with at most two places.
 */
export function parseAmount(text: string): Micros | null {
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(text)) return null;
  const [whole = "0", frac = ""] = text.split(".");
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(2, "0")) * (UNIT / 100n);
}

/** Base units back to the shortest decimal string: 50_000_000n → "50". */
export function amountParam(micros: Micros): string {
  const whole = micros / UNIT;
  const cents = (micros % UNIT) / (UNIT / 100n);
  return cents === 0n ? whole.toString() : `${whole}.${cents.toString().padStart(2, "0").replace(/0$/, "")}`;
}

/* ── Local currency (display only) ─────────────────────────────────────────── */

/*
 * The local-currency line under a dollar amount reads a live Chainlink rate
 * (`@polaris/fx`, served by /api/fx; see components/local-equivalent.tsx).
 * Nothing is ever priced or settled in it. There are no built-in rates: a
 * currency without a Chainlink feed simply shows no local amount.
 */

const REGION_CURRENCY: Readonly<Record<string, string>> = {
  US: "USD", AR: "ARS", BR: "BRL", MX: "MXN", CO: "COP", CL: "CLP", PE: "PEN",
  GB: "GBP", CH: "CHF", SE: "SEK", NO: "NOK", PL: "PLN", TR: "TRY",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", PT: "EUR", IE: "EUR",
  AT: "EUR", BE: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", SK: "EUR", SI: "EUR",
  EE: "EUR", LV: "EUR", LT: "EUR", HR: "EUR", CY: "EUR", MT: "EUR",
  PH: "PHP", IN: "INR", PK: "PKR", ID: "IDR", VN: "VND", TH: "THB", MY: "MYR",
  SG: "SGD", JP: "JPY", KR: "KRW", CN: "CNY", NG: "NGN", KE: "KES", GH: "GHS",
  ZA: "ZAR", EG: "EGP", AE: "AED", CA: "CAD", AU: "AUD", NZ: "NZD",
};

/** What Settings offers: dollars only, or a currency Chainlink publishes a rate for. */
export const LOCAL_CURRENCIES: readonly string[] = ["USD", ...[...FX_CURRENCIES].sort()];

/**
 * The currency a locale implies: "es-AR" → ARS, "de" → EUR (via likely
 * subtags). It may be one with no Chainlink rate (es-CL → CLP); then no local
 * amount shows, and Settings says why.
 */
export function currencyForLocale(locale: string): string {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return (region && REGION_CURRENCY[region]) || "USD";
  } catch {
    return "USD";
  }
}

/** Settings' local-currency picker: Automatic, dollars only, then every currency with a rate. */
export function localCurrencyOptions(auto: string, saved: string | null): { value: string; label: string; text: string }[] {
  const codes = saved && !LOCAL_CURRENCIES.includes(saved) ? [...LOCAL_CURRENCIES, saved] : LOCAL_CURRENCIES;
  return [
    { value: "auto", label: `Automatic (${auto})`, text: "Automatic" },
    ...codes.map((code) => ({ value: code, label: code === "USD" ? "USD (dollars only)" : code, text: code })),
  ];
}

/** What Settings says under the picker, for the currency in effect. */
export function localCurrencyHint(currency: string): string {
  const base = "Shown next to dollars at the Chainlink exchange rate, for reference only. You always pay in dollars.";
  return currency === "USD" || hasFxFeed(currency) ? base : `${base} There's no Chainlink rate for ${currency} yet, so no local amounts show.`;
}
