/**
 * The credit guard: whether a buyer can start a new Pay in 4 plan right now.
 *
 * Polaris's credit guard is an on-chain contract (CreditGuard) that reads the
 * credit pool live: when the pool is short of free cash or carries bad debt,
 * or the owner pauses it, PolarisCheckout refuses new Pay in 4 plans. Pay now
 * and Subscribe keep working, and plans already open keep collecting. There
 * are no reports to go stale on Arc; `stale` and `never` remain in the type for
 * older deployments.
 *
 * `GET /api/public/credit-guard` on the Polaris API; the server SDK reads it
 * with `polaris.credit.guard()`, and `<PolarisMessaging paused>` says so.
 */

/**
 * Why the guard paused credit (CreditGuard's reason bits, by name). On Arc the
 * guard reports `low_cash`, `bad_debt` and `owner_pause`; `depeg` and
 * `stale_price` stay in the union for older deployments and are never sent.
 */
export type CreditGuardReason = "depeg" | "low_cash" | "bad_debt" | "stale_price" | "owner_pause";

export type CreditGuardStatus = {
  /**
   * `open`: healthy; `paused`: new Pay in 4 plans are refused; `stale` and
   * `never`: the guard is late or hasn't reported, and blocks nothing;
   * `unconfigured`: no guard on this network; `unavailable`: the chain
   * couldn't be read (treated as open, as the contract does).
   */
  state: "open" | "paused" | "stale" | "never" | "unconfigured" | "unavailable";
  /** True while new Pay in 4 plans are refused. */
  paused: boolean;
  reasons: CreditGuardReason[];
  /** The sentence to show buyers while paused: "Pay in 4 is paused by our risk guard; pay now works as usual." */
  message: string | null;
  /** When the guard last checked the pool (ISO 8601), and how long before `readAt` that was, in seconds. */
  checkedAt: string | null;
  ageSeconds: number | null;
  readAt: string;
};

/** The sentence buyers see while the guard has paused Pay in 4. */
export const CREDIT_PAUSED_MESSAGE = "Pay in 4 is paused by our risk guard; pay now works as usual.";
