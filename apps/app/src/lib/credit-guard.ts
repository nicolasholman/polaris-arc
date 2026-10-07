import type { CreditGuardReason, CreditGuardView, PaymentLink } from "./data/types";

/**
 * The credit guard in the buyer's words. Polaris for Business serves it
 * (`GET /api/public/credit-guard`, and inside every checkout session):
 * CreditGuard on Arc reads the credit pool live and pauses new Pay in 4
 * plans when the pool is short of cash, carries bad debt, or its owner has
 * paused it, as PolarisCheckout.openPlan applies it. While it is paused,
 * Pay in 4 is shown as unavailable and Pay now carries on. There is no
 * report to go stale: the guard is a read of the pool, not an attestation.
 */

/** What the buyer reads wherever Pay in 4 is offered while the guard has paused it. */
export const GUARD_PAUSED_MESSAGE = "Pay in 4 is paused by our credit guard; pay now works as usual.";

const REASONS: ReadonlySet<CreditGuardReason> = new Set(["low_cash", "bad_debt", "owner_pause"]);

/** Each reason, as the buyer may read it. */
export const GUARD_REASON_LABELS: Record<CreditGuardReason, string> = {
  low_cash: "The credit pool is low on cash",
  bad_debt: "The credit pool is carrying unpaid plans",
  owner_pause: "Polaris paused new plans",
};

/**
 * The guard as the API sends it (the fields the app reads). `ageSeconds` is
 * always null on Arc and is ignored; an older API's "stale" or "never"
 * states read as open (the guard fails open).
 */
export type ApiCreditGuard = {
  state: string;
  paused: boolean;
  reasons?: string[] | null;
  message?: string | null;
  ageSeconds?: number | null;
  readAt: string;
};

export function toGuardView(g: ApiCreditGuard): CreditGuardView {
  const state: CreditGuardView["state"] =
    g.state === "paused" || g.state === "unconfigured" || g.state === "unavailable" ? g.state : g.paused ? "paused" : "open";
  return {
    state,
    paused: g.paused,
    reasons: g.paused ? (g.reasons ?? []).filter((r): r is CreditGuardReason => REASONS.has(r as CreditGuardReason)) : [],
    message: g.paused ? (g.message ?? GUARD_PAUSED_MESSAGE) : null,
    readAt: Date.parse(g.readAt),
  };
}

/**
 * Why Pay in 4 is shown but can't be chosen at a checkout: the credit guard
 * has paused new plans. The option stays on screen with the guard's words,
 * so the buyer knows it exists and why it's off, and Pay now carries on.
 */
export function laterPausedMessage(link: PaymentLink): string | null {
  const s = link.session;
  return !link.modes.later && s?.creditGuard?.paused && s.payLaterUnavailable ? s.payLaterUnavailable : null;
}
