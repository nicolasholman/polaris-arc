import type { CreditGuardView, PaymentLink } from "./data/types";

/**
 * The risk guard in the buyer's words. Polaris for Business serves the
 * guard (`GET /api/public/credit-guard`, and inside every checkout session):
 * the Chainlink CRE guardian's verdict on the credit pool, as
 * PolarisCheckout.openPlan applies it. While it has paused credit, Pay in 4
 * is shown as unavailable and Pay now carries on; when it has stopped
 * reporting it fails open, and the screens say when it last checked.
 */

/** What the buyer reads wherever Pay in 4 is offered while the guard has paused it. */
export const GUARD_PAUSED_MESSAGE = "Pay in 4 is paused by our risk guard; pay now works as usual.";

/** The guard as the API sends it (the fields the app reads). */
export type ApiCreditGuard = {
  state: CreditGuardView["state"];
  paused: boolean;
  message?: string | null;
  ageSeconds: number | null;
  readAt: string;
};

export function toGuardView(g: ApiCreditGuard): CreditGuardView {
  return {
    state: g.state,
    paused: g.paused,
    message: g.paused ? (g.message ?? GUARD_PAUSED_MESSAGE) : null,
    ageSeconds: g.ageSeconds,
    readAt: Date.parse(g.readAt),
  };
}

/** Seconds since the guard last checked, as of `now`. */
export function guardAge(g: CreditGuardView, now = Date.now()): number | null {
  if (g.ageSeconds === null) return null;
  return g.ageSeconds + Math.max(0, Math.floor((now - g.readAt) / 1000));
}

/** "Risk guard last checked 72 min ago", for a stale guard; null otherwise. */
export function staleGuardLine(g: CreditGuardView | null | undefined, now = Date.now()): string | null {
  if (!g || g.state !== "stale") return null;
  const age = guardAge(g, now);
  if (age === null) return null;
  const minutes = Math.floor(age / 60);
  const when = minutes < 120 ? `${Math.max(1, minutes)} min ago` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} days ago`;
  return `Risk guard last checked ${when}`;
}

/**
 * Why Pay in 4 is shown but can't be chosen at a checkout: the risk guard
 * has paused new plans. The option stays on screen with the guard's words,
 * so the buyer knows it exists and why it's off, and Pay now carries on.
 */
export function laterPausedMessage(link: PaymentLink): string | null {
  const s = link.session;
  return !link.modes.later && s?.creditGuard?.paused && s.payLaterUnavailable ? s.payLaterUnavailable : null;
}
