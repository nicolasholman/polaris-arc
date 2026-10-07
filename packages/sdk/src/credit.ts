/**
 * The credit guard: whether a buyer can start a new Pay in 4 plan right now.
 *
 * Polaris's Chainlink CRE guardian workflow watches the credit pool and the
 * AUSD/USD price and, when either is unhealthy, pauses new Pay in 4 plans on
 * chain (PolarisCheckout refuses them). Pay now and Subscribe keep working,
 * and plans already open keep collecting. A guard that stopped reporting
 * fails open: Pay in 4 stays on, and `state` is "stale".
 *
 * `GET /api/public/credit-guard` on the Polaris API; the server SDK reads it
 * with `polaris.credit.guard()`, and `<PolarisMessaging paused>` says so.
 */

/** Why the guard paused credit (GuardianReceiver's reason bits, by name). */
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
