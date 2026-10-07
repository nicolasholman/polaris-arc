import type { IsoDate } from "./types";

/**
 * The credit guard: CreditGuard's answer, as PolarisCheckout.openPlan applies
 * it. When it says credit is paused, new Pay in 4 plans are refused; Pay now,
 * Send and Subscribe never ask it. CreditGuard reads the credit pool itself
 * on every call (USDC is Arc's unit of account, so there is no peg to
 * attest): low free cash or too much bad debt pauses new plans, and the
 * owner can force a pause or a resume.
 *
 * These are the shapes the API serves (`GET /api/public/credit-guard`, the
 * dashboard's `GET /api/automation`) and the pure helpers that read them, safe
 * in the browser and on the server.
 */

/** CreditGuard's reason bits, by name. */
export type GuardReason = "low_cash" | "bad_debt" | "owner_pause";

/** CreditGuard.REASON_*: 2, 4 and the owner's 0x80. */
export const GUARD_REASON_BITS: Readonly<Record<GuardReason, number>> = {
  low_cash: 2,
  bad_debt: 4,
  owner_pause: 0x80,
};

/** The reasons a bitmask carries, in bit order. Unknown bits are ignored. */
export function reasonsFromMask(mask: number): GuardReason[] {
  return (Object.keys(GUARD_REASON_BITS) as GuardReason[]).filter((r) => (mask & GUARD_REASON_BITS[r]) !== 0);
}

/** Why credit is paused, in the merchant's words. */
export const GUARD_REASON_TEXT: Readonly<Record<GuardReason, string>> = {
  low_cash: "The credit pool's free cash fell below its floor",
  bad_debt: "Bad debt passed its share of everything lent",
  owner_pause: "Polaris paused Pay in 4 by hand",
};

/** What a buyer reads wherever Pay in 4 is offered while the guard has paused it. */
export const GUARD_PAUSED_MESSAGE = "Pay in 4 is paused by our risk guard; pay now works as usual.";

/**
 * - `open`: the pool passes (or the owner forced credit open).
 * - `paused`: new Pay in 4 plans are refused now.
 * - `unconfigured`: no guard is deployed, or PolarisCheckout asks none.
 * - `unavailable`: the chain couldn't be read just now (PolarisCheckout fails open on the same).
 */
export type CreditGuardState = "open" | "paused" | "unconfigured" | "unavailable";

export type GuardOverride = "none" | "resume" | "pause";

/** One of the guard's two checks, against today's thresholds, read from the pool now. */
export type GuardCheck = {
  key: "cash" | "bad_debt";
  label: string;
  /** The figure, in words ("$48,210.00", "0.00% of lent"). */
  value: string;
  /** Its limit, in words ("at least $1,000.00"). */
  limit: string;
  ok: boolean;
  source: "pool";
};

export type CreditGuard = {
  state: CreditGuardState;
  /** What PolarisCheckout.openPlan applies right now (`creditPaused()`): true refuses new Pay in 4 plans. */
  paused: boolean;
  reasons: GuardReason[];
  /** GUARD_PAUSED_MESSAGE while paused, else null. */
  message: string | null;
  /** Always null: the guard reads the pool live, so there is no attestation to age. Kept for older clients. */
  ageSeconds: null;
  override: GuardOverride;
  /** When a forced resume ends by itself (CreditGuard caps it at a day); null otherwise. */
  overrideUntil: IsoDate | null;
  /** CreditGuard, when one is deployed. */
  guardian: `0x${string}` | null;
  /**
   * PolarisCheckout asks another guard than the one this API is configured
   * with (a redeploy the API's env hasn't caught up with). `paused` and
   * `reasons` are still the checkout's own answer; the rest is unknown.
   */
  mismatch: { checkoutGuardian: `0x${string}`; configuredGuardian: `0x${string}` } | null;
  /** When the API read the chain. */
  readAt: IsoDate;
  thresholds: {
    minFreeCashUnits: string;
    maxBadDebtBps: number;
    /** The bad-debt share applies only once this much has been lent. */
    minOriginatedUnits: string;
  } | null;
  /** The credit pool now (PolarisLoanEngine.poolState). */
  pool: {
    freeCashUnits: string;
    totalOwedUnits: string;
    badDebtUnits: string;
    totalOriginatedUnits: string;
    /** Bad debt the owner acknowledged: only bad debt beyond it counts. */
    badDebtAcknowledgedUnits: string;
  } | null;
  checks: GuardCheck[];
};

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 6-decimal stablecoin units as "$1,234.56" (truncated to the cent). */
export function unitsToUsd(units: string | bigint): string {
  const u = typeof units === "bigint" ? units : BigInt(units);
  const negative = u < 0n;
  const cents = (negative ? -u : u) / 10_000n;
  const text = DOLLARS.format(Number(cents) / 100);
  return negative ? `−${text}` : text;
}

/** A fixed-point integer with `decimals` decimals as a decimal string, trailing zeros trimmed to `min` places. */
export function fixed(value: bigint, decimals: number, min = 2): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < min) frac = frac.padEnd(min, "0");
  return `${negative ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

/** CreditGuard.Thresholds, as the chain returns them. */
export type GuardThresholds = {
  minFreeCash: bigint;
  maxBadDebtBps: number;
  minOriginated: bigint;
};

/**
 * The guard's two checks, with the figures in words: the free cash and the
 * bad debt from the pool now, under `t` and the bad debt the owner
 * acknowledged. The same formula as CreditGuard.poolReasons: `ok: false` on
 * exactly the reasons it would set.
 */
export function guardChecks(
  pool: { freeCash: bigint; badDebt: bigint; totalOriginated: bigint },
  t: GuardThresholds,
  badDebtAcknowledged = 0n,
): GuardCheck[] {
  const counted = pool.badDebt > badDebtAcknowledged ? pool.badDebt - badDebtAcknowledged : 0n;
  const applies = pool.totalOriginated >= t.minOriginated;
  const badDebtLimit = (pool.totalOriginated * BigInt(t.maxBadDebtBps)) / 10_000n;
  const share = pool.totalOriginated === 0n ? 0 : Number((counted * 1_000_000n) / pool.totalOriginated) / 10_000;
  const pct = (t.maxBadDebtBps / 100).toFixed(2).replace(/\.00$/, "");
  return [
    { key: "cash", label: "Free pool cash", value: unitsToUsd(pool.freeCash), limit: `at least ${unitsToUsd(t.minFreeCash)}`, ok: pool.freeCash >= t.minFreeCash, source: "pool" },
    {
      key: "bad_debt",
      label: "Bad debt",
      value: `${share.toFixed(2)}% of lent${badDebtAcknowledged > 0n ? ` (after ${unitsToUsd(badDebtAcknowledged)} acknowledged)` : ""}`,
      limit: applies ? `at most ${pct}%` : `at most ${pct}%, from ${unitsToUsd(t.minOriginated)} lent`,
      ok: !applies || counted <= badDebtLimit,
      source: "pool",
    },
  ];
}
