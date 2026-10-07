import type { IsoDate } from "./types";

/**
 * The credit guard: GuardianReceiver's answer, as PolarisCheckout.openPlan
 * applies it. When it says credit is paused, new Pay in 4 plans are refused;
 * Pay now, Send and Subscribe never ask it. Two halves:
 *
 * - the price (depeg, stale price): the Chainlink CRE `polaris-guardian`
 *   workflow's attestation of Chainlink AUSD/USD on Monad mainnet. An
 *   attestation older than the guard's `maxAttestationAge` fails open, so
 *   Pay in 4 keeps working and the screens say when it last checked;
 * - the pool (low cash, bad debt): read by GuardianReceiver from the credit
 *   pool itself on every call, so it never goes stale and no report sets it.
 *
 * These are the shapes the API serves (`GET /api/public/credit-guard`, the
 * dashboard's `GET /api/chainlink`) and the pure helpers that read them, safe
 * in the browser and on the server.
 */

/** GuardianReceiver's reason bits, by name. */
export type GuardReason = "depeg" | "low_cash" | "bad_debt" | "stale_price" | "owner_pause";

/** GuardianReceiver.REASON_*: 1, 2, 4, 8 and the owner's 0x80. */
export const GUARD_REASON_BITS: Readonly<Record<GuardReason, number>> = {
  depeg: 1,
  low_cash: 2,
  bad_debt: 4,
  stale_price: 8,
  owner_pause: 0x80,
};

/** The reasons a bitmask carries, in bit order. Unknown bits are ignored. */
export function reasonsFromMask(mask: number): GuardReason[] {
  return (Object.keys(GUARD_REASON_BITS) as GuardReason[]).filter((r) => (mask & GUARD_REASON_BITS[r]) !== 0);
}

/** Why credit is paused, in the merchant's words. */
export const GUARD_REASON_TEXT: Readonly<Record<GuardReason, string>> = {
  depeg: "AUSD/USD left its band",
  low_cash: "The credit pool's free cash fell below its floor",
  bad_debt: "Bad debt passed its share of everything lent",
  stale_price: "The AUSD/USD price was too old to trust",
  owner_pause: "Polaris paused Pay in 4 by hand",
};

/** What a buyer reads wherever Pay in 4 is offered while the guard has paused it. */
export const GUARD_PAUSED_MESSAGE = "Pay in 4 is paused by our risk guard; pay now works as usual.";

/**
 * - `open`: a fresh attestation says the peg is healthy and the pool passes (or the owner forced credit open).
 * - `paused`: new Pay in 4 plans are refused now.
 * - `stale`: the latest attestation is older than the guard's `maxAttestationAge`: its price checks fail open (the pool's still apply).
 * - `never`: no attestation yet: the price checks fail open (the pool's still apply).
 * - `unconfigured`: no guardian is deployed, or PolarisCheckout asks none.
 * - `unavailable`: the chain couldn't be read just now (PolarisCheckout fails open on the same).
 */
export type CreditGuardState = "open" | "paused" | "stale" | "never" | "unconfigured" | "unavailable";

export type GuardOverride = "none" | "resume" | "pause";

/** One of the guardian's four checks, against today's thresholds. */
export type GuardCheck = {
  key: "price" | "cash" | "bad_debt" | "price_age";
  label: string;
  /** The figure, in words ("$0.9998", "$48,210.00", "0.00% of lent", "12 min"). */
  value: string;
  /** Its limit, in words ("between $0.995 and $1.005"). */
  limit: string;
  ok: boolean;
  /**
   * Where the figure comes from: `attestation`, the CRE workflow's latest
   * report (Chainlink AUSD/USD on Monad mainnet), or `pool`, the credit pool
   * itself, which GuardianReceiver reads on every call.
   */
  source: "attestation" | "pool";
};

export type CreditGuard = {
  state: CreditGuardState;
  /** What PolarisCheckout.openPlan applies right now (`creditPaused()`): true refuses new Pay in 4 plans. */
  paused: boolean;
  reasons: GuardReason[];
  /** GUARD_PAUSED_MESSAGE while paused, else null. */
  message: string | null;
  /** The latest attestation's `observedAt`: when the guard last checked. Null before the first. */
  checkedAt: IsoDate | null;
  /** How old that check was when this was read, by the chain's clock (seconds). */
  ageSeconds: number | null;
  /** Past this age an attestation is stale and credit fails open. */
  maxAgeSeconds: number | null;
  override: GuardOverride;
  /** When a forced resume ends by itself (GuardianReceiver caps it at a day); null otherwise. */
  overrideUntil: IsoDate | null;
  /** GuardianReceiver, when one is deployed. */
  guardian: `0x${string}` | null;
  /**
   * PolarisCheckout asks another guardian than the one this API is configured
   * with (a redeploy the API's env hasn't caught up with). `paused` and
   * `reasons` are still the checkout's own answer; the rest is unknown.
   */
  mismatch: { checkoutGuardian: `0x${string}`; configuredGuardian: `0x${string}` } | null;
  /** Rounds written so far (its feed's latest round id). */
  round: number | null;
  /** When the API read the chain. */
  readAt: IsoDate;
  /** The latest attestation's own verdict (an owner override, staleness and today's pool are not in it). */
  attested: { paused: boolean; reasons: GuardReason[] } | null;
  /** Which of the reasons now come from the pool itself, and which from the latest attestation's price. */
  sources: { pool: GuardReason[]; price: GuardReason[] } | null;
  thresholds: {
    /** AUSD/USD floor and ceiling, dollars ("0.995", "1.005"). */
    minPrice: string;
    maxPrice: string;
    minFreeCashUnits: string;
    maxBadDebtBps: number;
    /** The bad-debt share applies only once this much has been lent. */
    minOriginatedUnits: string;
    maxPriceAgeSeconds: number;
  } | null;
  /** The credit pool now, as GuardianReceiver reads it (PolarisLoanEngine.poolState). */
  pool: {
    freeCashUnits: string;
    totalOwedUnits: string;
    badDebtUnits: string;
    totalOriginatedUnits: string;
    /** Bad debt the owner acknowledged: only bad debt beyond it counts. */
    badDebtAcknowledgedUnits: string;
  } | null;
  attestation: {
    /** The Chainlink AUSD/USD round the workflow cited, and its answer in dollars. */
    priceRoundId: string;
    price: string;
    priceUpdatedAt: IsoDate | null;
    freeCashUnits: string;
    totalOwedUnits: string;
    badDebtUnits: string;
    totalOriginatedUnits: string;
    observedAt: IsoDate;
  } | null;
  checks: GuardCheck[];
  /**
   * GuardianReceiver read as a feed (AggregatorV3Interface `latestRoundData`):
   * "Polaris pool health, computed by CRE": what the pool can lend now, in
   * dollars (free cash at the attested AUSD price; 0 when the attestation
   * paused credit). A Polaris attestation computed by a CRE workflow, not a
   * Chainlink Data Feed and not Proof of Reserve.
   */
  feed: {
    address: `0x${string}`;
    description: string;
    decimals: number;
    roundId: string;
    /** The raw answer, `decimals` decimals. */
    answer: string;
    /** The same in dollars ("48,210.36"). */
    answerUsd: string;
    updatedAt: IsoDate | null;
  } | null;
  /** The price feed the workflow reads: Chainlink AUSD/USD on Monad mainnet, or a labelled local stand-in. */
  priceFeed: { chainId: number | null; address: `0x${string}`; description: string; kind: "chainlink" | "mock" } | null;
};

/** Seconds since the guard last checked, as of `now`, from what the API read at `readAt`. */
export function guardAgeSeconds(guard: Pick<CreditGuard, "ageSeconds" | "readAt">, now = Date.now()): number | null {
  if (guard.ageSeconds === null) return null;
  const since = Math.max(0, Math.floor((now - Date.parse(guard.readAt)) / 1000));
  return guard.ageSeconds + since;
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function checkedAgo(seconds: number): string {
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "Last checked 4 min ago", or null before the first check. */
export function lastCheckedLine(guard: Pick<CreditGuard, "ageSeconds" | "readAt">, now = Date.now()): string | null {
  const age = guardAgeSeconds(guard, now);
  return age === null ? null : `Last checked ${checkedAgo(age)}`;
}

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

function duration(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} h`;
}

/** GuardianReceiver.Thresholds, as the chain returns them. */
export type GuardThresholds = {
  minPrice: bigint;
  maxPrice: bigint;
  minFreeCash: bigint;
  maxBadDebtBps: number;
  minOriginated: bigint;
  maxPriceAge: number;
};

/**
 * The guardian's four checks, with the figures in words: the price and its
 * age from the latest attestation `a` (none when there is no attestation),
 * the free cash and the bad debt from the pool now, under `t` and the bad
 * debt the owner acknowledged. The same formula as GuardianReceiver
 * (evaluate, and isCreditPaused's live pool read): `ok: false` on exactly
 * the reasons it would set.
 */
export function guardChecks(
  a: { price: bigint; priceUpdatedAt: bigint; observedAt: bigint } | null,
  pool: { freeCash: bigint; badDebt: bigint; totalOriginated: bigint },
  t: GuardThresholds,
  badDebtAcknowledged = 0n,
): GuardCheck[] {
  const counted = pool.badDebt > badDebtAcknowledged ? pool.badDebt - badDebtAcknowledged : 0n;
  const applies = pool.totalOriginated >= t.minOriginated;
  const badDebtLimit = (pool.totalOriginated * BigInt(t.maxBadDebtBps)) / 10_000n;
  const share = pool.totalOriginated === 0n ? 0 : Number((counted * 1_000_000n) / pool.totalOriginated) / 10_000;
  const pct = (t.maxBadDebtBps / 100).toFixed(2).replace(/\.00$/, "");
  const checks: GuardCheck[] = [];
  if (a) {
    checks.push({
      key: "price",
      label: "AUSD/USD",
      value: `$${fixed(a.price, 8, 4)}`,
      limit: `between $${fixed(t.minPrice, 8, 3)} and $${fixed(t.maxPrice, 8, 3)}`,
      ok: a.price >= t.minPrice && a.price <= t.maxPrice,
      source: "attestation",
    });
  }
  checks.push(
    { key: "cash", label: "Free pool cash", value: unitsToUsd(pool.freeCash), limit: `at least ${unitsToUsd(t.minFreeCash)}`, ok: pool.freeCash >= t.minFreeCash, source: "pool" },
    {
      key: "bad_debt",
      label: "Bad debt",
      value: `${share.toFixed(2)}% of lent${badDebtAcknowledged > 0n ? ` (after ${unitsToUsd(badDebtAcknowledged)} acknowledged)` : ""}`,
      limit: applies ? `at most ${pct}%` : `at most ${pct}%, from ${unitsToUsd(t.minOriginated)} lent`,
      ok: !applies || counted <= badDebtLimit,
      source: "pool",
    },
  );
  if (a) {
    const priceAge = a.observedAt > a.priceUpdatedAt ? a.observedAt - a.priceUpdatedAt : 0n;
    const priceStale = a.priceUpdatedAt === 0n || priceAge > BigInt(t.maxPriceAge);
    checks.push({
      key: "price_age",
      label: "Price age",
      value: a.priceUpdatedAt === 0n ? "no price" : duration(Number(priceAge)),
      limit: `at most ${duration(t.maxPriceAge)}`,
      ok: !priceStale,
      source: "attestation",
    });
  }
  return checks;
}
