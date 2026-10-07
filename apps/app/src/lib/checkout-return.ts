import type { PaymentLink } from "./data/types";
import type { RelayReceipt } from "./relayer";

/**
 * How the hosted checkout reports back to the merchant page that opened it,
 * exactly as polarispay-sdk's `openCheckout` listens (packages/sdk README,
 * "Checkout ↔ page messages"):
 *
 *   { type: "polaris:checkout", version: 1, event: "ready" | "completed" | "canceled" | "expired",
 *     sessionId, mode?, orderId?, txHash?, paymentId?, planId?, subscriptionId? }
 *
 * posted to `window.opener` with the session's return origin (the origin of
 * its successUrl) as the target, never "*". Opened with `?display=popup`, the
 * checkout posts its result and closes; otherwise it goes to `successUrl`.
 * It must not be served with `Cross-Origin-Opener-Policy: same-origin`.
 *
 * The /pay/[id] route (sheets/checkout.tsx `CheckoutRoute`) calls
 * `announceReady` on load (`expireCheckout` for an expired session),
 * `postCompleted` the moment the payment is final and `returnToMerchant`
 * from the receipt (a popup closes itself a few seconds after paying), and
 * `cancelCheckout` when the buyer backs out.
 */

export type CheckoutEvent = "ready" | "completed" | "canceled" | "expired";
type Mode = "now" | "later" | "subscription" | "subscribe";

export function checkoutMessage(
  event: CheckoutEvent,
  sessionId: string,
  details: { mode?: "now" | "later" | "subscribe"; orderId?: string; txHash?: string; paymentId?: string; planId?: string; subscriptionId?: string } = {},
) {
  return { type: "polaris:checkout" as const, version: 1 as const, event, sessionId, ...details };
}

export function isPopupCheckout(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("display") === "popup";
}

/** Post to the opener, if this is a real session with an opener. Returns whether it posted. */
function post(link: PaymentLink, message: ReturnType<typeof checkoutMessage>): boolean {
  if (typeof window === "undefined" || !link.session || !window.opener) return false;
  try {
    (window.opener as Window).postMessage(message, link.session.returnOrigin);
    return true;
  } catch {
    return false;
  }
}

export function announceReady(link: PaymentLink): void {
  post(link, checkoutMessage("ready", link.id));
}

/** Tell the opener the checkout completed. Returns whether a message went out. */
export function postCompleted(link: PaymentLink, mode: Mode, receipt: RelayReceipt): boolean {
  return post(
    link,
    checkoutMessage("completed", link.id, {
      mode: mode === "subscription" ? "subscribe" : mode,
      orderId: link.orderId,
      txHash: receipt.txHash,
      paymentId: receipt.paymentId,
      planId: receipt.planId,
      subscriptionId: receipt.subscriptionId,
    }),
  );
}

/**
 * The merchant's page to go back to: the session's successUrl, unless that
 * is this app itself. A dashboard payment link has no merchant page (its
 * sessions come back to Polaris), so "Back to {merchant}" would only open
 * the paid checkout again. Before hydration the successUrl stands.
 */
export function merchantReturnUrl(link: PaymentLink): string | null {
  const url = link.successUrl;
  if (!url || typeof window === "undefined") return url ?? null;
  try {
    return new URL(url, window.location.href).origin === window.location.origin ? null : url;
  } catch {
    return null;
  }
}

/**
 * Back to the merchant after the receipt: close the popup (its opener
 * already has the result), or go to the session's success page. Returns
 * false when there is nowhere to go back to (a dashboard payment link, or a
 * checkout opened directly), so the buyer stays in Polaris.
 */
export function returnToMerchant(link: PaymentLink): boolean {
  if (typeof window === "undefined") return false;
  const successUrl = merchantReturnUrl(link);
  if (isPopupCheckout() && window.opener) {
    window.close();
    // A browser that refuses to close the window goes to the success page instead.
    if (successUrl) window.setTimeout(() => window.location.assign(successUrl), 300);
    return true;
  }
  if (successUrl) {
    window.location.assign(successUrl);
    return true;
  }
  return false;
}

/**
 * The buyer backed out: tell the opener and close the popup, or go to the
 * session's cancel page. Returns false when neither applies.
 */
export function cancelCheckout(link: PaymentLink): boolean {
  const posted = post(link, checkoutMessage("canceled", link.id));
  if (posted && isPopupCheckout()) {
    window.close();
    return true;
  }
  if (link.session?.cancelUrl) {
    window.location.assign(link.session.cancelUrl);
    return true;
  }
  return posted;
}

export function expireCheckout(link: PaymentLink): void {
  post(link, checkoutMessage("expired", link.id));
}
