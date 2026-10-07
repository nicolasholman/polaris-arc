import { CHECKOUT_MODES, type CheckoutMode, type Hex } from "../types.js";
import type { CheckoutResult } from "./types.js";

/**
 * The postMessage protocol between the hosted checkout (the Polaris app at
 * pay.polarispay.app/pay/{id}) and the merchant page that opened it.
 *
 * The checkout posts to `window.opener`, with the origin of the session's
 * `successUrl` as the target origin, so only the merchant's own page can read
 * it. The SDK accepts a message only when `event.origin` is the checkout
 * origin and `event.source` is the window it opened.
 *
 *   { type: "polaris:checkout", version: 1, event: "ready",     sessionId }
 *   { type: "polaris:checkout", version: 1, event: "completed", sessionId, mode, orderId, txHash, paymentId?, planId?, subscriptionId? }
 *   { type: "polaris:checkout", version: 1, event: "canceled",  sessionId }
 *   { type: "polaris:checkout", version: 1, event: "expired",   sessionId }
 *
 * The app's first checkout sent `{ type: "polaris:payment", status: "paid",
 * linkId, orderId, mode, txHash }`; that is still understood as "completed".
 */

export const CHECKOUT_MESSAGE_TYPE = "polaris:checkout";
export const CHECKOUT_PROTOCOL_VERSION = 1;

export type CheckoutMessageEvent = "ready" | "completed" | "canceled" | "expired";

export type CheckoutMessage = {
  type: typeof CHECKOUT_MESSAGE_TYPE;
  version: typeof CHECKOUT_PROTOCOL_VERSION;
  event: CheckoutMessageEvent;
  sessionId: string;
  mode?: CheckoutMode;
  orderId?: string;
  txHash?: Hex;
  paymentId?: Hex;
  planId?: string;
  subscriptionId?: string;
};

/** What the opener does with a message: nothing yet ("ready"), or finish with a result. */
export type ParsedCheckoutMessage =
  | { kind: "ready"; sessionId: string | null }
  | { kind: "result"; sessionId: string | null; result: CheckoutResult };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function hex(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,128}$/.test(value) ? (value as Hex) : null;
}

function mode(value: unknown): CheckoutMode | null {
  if (value === "subscription") return "subscribe";
  return CHECKOUT_MODES.includes(value as CheckoutMode) ? (value as CheckoutMode) : null;
}

/**
 * Parse an untrusted `MessageEvent.data`. Returns null for anything that
 * isn't a well-formed checkout message, so a stray message from another
 * script on the page (a wallet extension, an analytics iframe) is ignored.
 */
export function parseCheckoutMessage(data: unknown): ParsedCheckoutMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;

  if (m.type === "polaris:payment") {
    // The first checkout's message: only "paid" was ever sent.
    if (m.status !== "paid") return null;
    const sessionId = str(m.sessionId) ?? str(m.linkId);
    return {
      kind: "result",
      sessionId,
      result: {
        status: "completed",
        sessionId,
        mode: mode(m.mode) ?? "now",
        orderId: str(m.orderId),
        txHash: hex(m.txHash),
        paymentId: hex(m.paymentId),
        planId: str(m.planId),
        subscriptionId: str(m.subscriptionId),
      },
    };
  }

  if (m.type !== CHECKOUT_MESSAGE_TYPE || m.version !== CHECKOUT_PROTOCOL_VERSION) return null;
  const sessionId = str(m.sessionId);

  switch (m.event) {
    case "ready":
      return { kind: "ready", sessionId };
    case "completed": {
      const paidWith = mode(m.mode);
      if (!paidWith) return null;
      return {
        kind: "result",
        sessionId,
        result: {
          status: "completed",
          sessionId,
          mode: paidWith,
          orderId: str(m.orderId),
          txHash: hex(m.txHash),
          paymentId: hex(m.paymentId),
          planId: str(m.planId),
          subscriptionId: str(m.subscriptionId),
        },
      };
    }
    case "canceled":
      return { kind: "result", sessionId, result: { status: "canceled", sessionId } };
    case "expired":
      return { kind: "result", sessionId, result: { status: "expired", sessionId } };
    default:
      return null;
  }
}

/**
 * For the hosted checkout: build a protocol message. Post it with
 * `window.opener.postMessage(message, new URL(session.successUrl).origin)`,
 * never with "*".
 */
export function createCheckoutMessage(
  event: CheckoutMessageEvent,
  sessionId: string,
  details: Omit<CheckoutMessage, "type" | "version" | "event" | "sessionId"> = {},
): CheckoutMessage {
  return { type: CHECKOUT_MESSAGE_TYPE, version: CHECKOUT_PROTOCOL_VERSION, event, sessionId, ...details };
}
