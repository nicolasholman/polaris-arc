import { invalidRequest } from "./errors.js";

/**
 * Dollar amounts, in integers.
 *
 * The API speaks decimal strings ("200.00"), the chain speaks AUSD base units
 * (6 decimals), and the buyer reads "$50.38". Nothing in between is a float:
 * 0.1 + 0.2 is not a price.
 */

/** AUSD and USDC both use 6 decimals. */
export const STABLECOIN_DECIMALS = 6;
const MICROS_PER_DOLLAR = 1_000_000n;
const MICROS_PER_CENT = 10_000n;

/** Anything the SDK accepts as an amount: "200", "200.5", "200.00", or 200.5. */
export type AmountInput = string | number;

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Parse a USD amount into integer cents. At most two decimals, strictly
 * positive, no signs, separators or exponents. Numbers are accepted when they
 * round-trip exactly to two decimals (200.5, not 0.1 + 0.2).
 */
export function toCents(input: AmountInput, param = "amount"): bigint {
  const text = normalise(input, param);
  if (!DECIMAL.test(text)) {
    throw invalidRequest("invalid_amount", `${param} must be a positive dollar amount like "200.00", got ${JSON.stringify(input)}.`, param);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > 2) {
    throw invalidRequest("invalid_amount", `${param} has more than two decimals: ${JSON.stringify(input)}.`, param);
  }
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (cents <= 0n) throw invalidRequest("invalid_amount", `${param} must be more than zero.`, param);
  return cents;
}

/** "200.00": the canonical form the API sends and receives. */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** Canonicalise an amount: "200" → "200.00". Throws on anything that isn't a positive two-decimal amount. */
export function normaliseAmount(input: AmountInput, param = "amount"): string {
  return formatCents(toCents(input, param));
}

/** Parse a decimal amount into base units of a token with `decimals` decimals. */
export function toBaseUnits(input: AmountInput, decimals: number, param = "amount"): bigint {
  const text = normalise(input, param);
  if (!DECIMAL.test(text)) {
    throw invalidRequest("invalid_amount", `${param} must be a positive amount like "25.00", got ${JSON.stringify(input)}.`, param);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw invalidRequest("invalid_amount", `${param} has more than ${decimals} decimals: ${JSON.stringify(input)}.`, param);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units <= 0n) throw invalidRequest("invalid_amount", `${param} must be more than zero.`, param);
  return units;
}

/** Base units back to a decimal string, trimming trailing zeros past the cents: 1534246n → "1.534246", 50000000n → "50.00". */
export function formatBaseUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  let fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  const text = `${abs / scale}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** Micro-dollars rounded half up to the cent, the way the app shows them, so $50.385 never shows as $50.38. */
export function microsToCents(micros: bigint): bigint {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const cents = (abs + MICROS_PER_CENT / 2n) / MICROS_PER_CENT;
  return negative ? -cents : cents;
}

export function centsToMicros(cents: bigint): bigint {
  return cents * MICROS_PER_CENT;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,284.50". Deterministic (fixed locale), so server and client render the same text. */
export function formatUsd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  // Whole dollars can exceed 2^53 only for absurd amounts; format the parts separately to stay exact.
  const whole = abs / 100n;
  const rest = abs % 100n;
  const text = USD.format(Number(whole)).replace(/\.00$/, `.${rest.toString().padStart(2, "0")}`);
  return negative ? `−${text}` : text;
}

/** Micro-dollars as "$50.38". */
export function formatUsdMicros(micros: bigint): string {
  return formatUsd(microsToCents(micros));
}

/**
 * A figure the SDK itself formatted ("50.38", "0.00") as "$50.38". Unlike
 * `formatUsd(toCents(…))` it accepts zero: a plan's interest or a tiny
 * instalment can round to "0.00", and a price tag must not throw on it.
 */
export function formatUsdAmount(value: string): string {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (!match) throw invalidRequest("invalid_amount", `Expected a two-decimal amount like "50.38", got ${JSON.stringify(value)}.`);
  return formatUsd(BigInt(match[1]!) * 100n + BigInt(match[2]!));
}

function normalise(input: AmountInput, param: string): string {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw invalidRequest("invalid_amount", `${param} must be a finite number.`, param);
    }
    // Only accept numbers that are exactly what they look like with two decimals.
    const fixed = input.toFixed(2);
    if (Number(fixed) !== input) {
      throw invalidRequest(
        "invalid_amount",
        `${param} ${input} isn't a whole number of cents. Pass a string like "200.00" instead.`,
        param,
      );
    }
    return fixed;
  }
  if (typeof input !== "string") {
    throw invalidRequest("invalid_amount", `${param} must be a string like "200.00".`, param);
  }
  return input.trim();
}

/* ── Pay in 4 ──────────────────────────────────────────────────────────── */

const DAY = 86_400;
const YEAR = 365 * DAY;

/**
 * Pay in 4 as PolarisLoanEngine prices it: simple interest at
 * `INTEREST_RATE_BPS` (10% APR), pro-rated over the plan's length, charged to
 * the buyer and never the merchant. The merchant is paid in full at checkout;
 * the buyer pays nothing then, and the first instalment falls due one
 * interval later.
 */
export const PAY_IN_4 = {
  installments: 4,
  /** One week between instalments, the product default. */
  intervalSeconds: 7 * DAY,
  /** `PolarisLoanEngine.INTEREST_RATE_BPS`. */
  aprBps: 1_000,
} as const;

export type PayIn4Options = {
  /** Number of instalments. Default 4. The first falls due one interval after checkout. */
  installments?: number;
  /** Seconds between instalments. Default one week. */
  intervalSeconds?: number;
  /**
   * Buyer APR in basis points. Default 1000 (10%): PolarisLoanEngine.INTEREST_RATE_BPS,
   * what every Polaris plan charges. Other values are for tests; a checkout never
   * quotes them.
   */
  aprBps?: number;
};

export type PayIn4Installment = {
  /** 1-based. */
  index: number;
  /**
   * "50.38", for display. Each is the step between two rungs of the ladder
   * rounded half up to the cent, so the displayed instalments always add up
   * to the displayed `total`, and each is within a cent of `amountBaseUnits`.
   */
  amount: string;
  /** Exact, in AUSD base units: what the loan engine will draw (`thresholdFor(index) - thresholdFor(index - 1)`). */
  amountBaseUnits: bigint;
  /**
   * Seconds from checkout until it's due: `index × intervalSeconds`, as
   * `PolarisLoanEngine.installmentDueAt` dates it. Nothing is due at checkout,
   * so the first is one interval out (a week, by default).
   */
  dueInSeconds: number;
};

export type PayIn4Quote = {
  principal: string;
  /** Total interest over the plan, to the cent: "1.53". */
  interest: string;
  total: string;
  /** What "4 × $X" shows: the first instalment, to the cent. Instalments differ by at most one base unit. */
  each: string;
  installments: PayIn4Installment[];
  aprBps: number;
  intervalSeconds: number;
  interestFree: boolean;
};

/**
 * Cumulative amount repaid once `k` of `count` instalments are complete:
 * `PolarisLoanEngine.thresholdFor`, rounded up, with the last rung exactly
 * the total owed. Every instalment is the step between two rungs, so the
 * schedule quoted here is the one the keeper collects, unit for unit.
 */
function thresholdFor(totalOwed: bigint, k: bigint, count: bigint): bigint {
  if (k === 0n) return 0n;
  if (k >= count) return totalOwed;
  return (totalOwed * k + count - 1n) / count;
}

/**
 * Quote Pay in 4 exactly as the loan engine computes it, in base units:
 *
 *   interest      = principal × aprBps × (installments × interval) / (10 000 × 365 days)
 *   thresholdFor k = ceil(total × k / installments), and total at k = installments
 *   instalment i  = thresholdFor(i) − thresholdFor(i − 1), due i × interval after checkout
 *
 * $200 over four weekly instalments at 10% is $1.53 of interest: 4 × $50.38,
 * the first a week after checkout. Nothing is paid at checkout.
 */
export function quotePayIn4(amount: AmountInput, options: PayIn4Options = {}): PayIn4Quote {
  const count = options.installments ?? PAY_IN_4.installments;
  const interval = options.intervalSeconds ?? PAY_IN_4.intervalSeconds;
  const aprBps = options.aprBps ?? PAY_IN_4.aprBps;
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    throw invalidRequest("invalid_installments", "installments must be a whole number from 1 to 24.", "installments");
  }
  if (!Number.isInteger(interval) || interval < 60 || interval > YEAR) {
    throw invalidRequest("invalid_interval", "intervalSeconds must be between 60 seconds and a year.", "intervalSeconds");
  }
  if (!Number.isInteger(aprBps) || aprBps < 0 || aprBps > 10_000) {
    throw invalidRequest("invalid_apr", "aprBps must be a whole number of basis points from 0 to 10000.", "aprBps");
  }

  const principal = toBaseUnits(amount, STABLECOIN_DECIMALS);
  const n = BigInt(count);
  const term = n * BigInt(interval);
  const interest = (principal * BigInt(aprBps) * term) / (10_000n * BigInt(YEAR));
  const total = principal + interest;

  const installments: PayIn4Installment[] = Array.from({ length: count }, (_, i) => {
    const k = BigInt(i + 1);
    const upper = thresholdFor(total, k, n);
    const lower = thresholdFor(total, k - 1n, n);
    return {
      index: i + 1,
      // Rounding the running total, not each instalment on its own, keeps
      // the rows summing to the total shown: $189 at 10% is 190.45, which
      // four separately rounded 47.61s would miss by a cent.
      amount: formatCents(microsToCents(upper) - microsToCents(lower)),
      amountBaseUnits: upper - lower,
      dueInSeconds: (i + 1) * interval,
    };
  });

  return {
    principal: formatCents(microsToCents(principal)),
    interest: formatCents(microsToCents(interest)),
    total: formatCents(microsToCents(total)),
    each: installments[0]!.amount,
    installments,
    aprBps,
    intervalSeconds: interval,
    interestFree: interest === 0n,
  };
}

/** Exposed for tests and callers who price in micro-dollars already. */
export const UNITS = { MICROS_PER_DOLLAR, MICROS_PER_CENT } as const;
