import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Order } from "./types";

/**
 * Who may read an order.
 *
 * The order id is in the receipt's URL, so it is not a secret. What proves a
 * browser placed the order is a random token, set as an HttpOnly cookie when
 * /api/checkout creates the order. With it, the order comes back whole;
 * without it (a shared link, a guessed id), the buyer's name, email and
 * address are masked, and nothing can be written to the order.
 *
 * Polaris and the chain never see either: they get the order's payRef.
 */

const COOKIE_PREFIX = "hc_o_";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function newAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

export function accessCookieName(orderId: string): string {
  return `${COOKIE_PREFIX}${orderId}`;
}

/** The Set-Cookie value that lets this browser read the order. */
export function accessCookie(order: Order, origin: string): string | null {
  if (!order.accessToken) return null;
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `${accessCookieName(order.id)}=${order.accessToken}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

/** The order's token from a request's Cookie header, if it sent one. */
export function tokenFromRequest(req: Request, orderId: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const name = accessCookieName(orderId);
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function canRead(order: Order, token: string | null | undefined): boolean {
  if (!order.accessToken || !token) return false;
  const a = Buffer.from(order.accessToken);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "lena.hartmann@example.com" → "l***@example.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * The order as a browser may see it. Never the access token. Without the
 * token: no name, no address, no phone, a masked email, and none of the
 * developer drawer's log; the status, the items and the payment plan stay,
 * so a receipt link still shows whether the order is paid.
 */
export function orderForBrowser(order: Order, readable: boolean): Order {
  const { accessToken: _token, ...rest } = order;
  void _token;
  if (readable) return rest;
  return {
    ...rest,
    redacted: true,
    contact: { email: maskEmail(order.contact.email) },
    address: { name: "", line1: "", city: "", postalCode: "", country: "" },
    payment: {
      method: order.payment.method,
      requestedMode: order.payment.requestedMode,
      mode: order.payment.mode,
      sessionAttempt: 0,
      paidAt: order.payment.paidAt,
      txHash: order.payment.txHash,
    },
    events: [],
    sdkLog: [],
  };
}

/** The reference the order goes by at Polaris and on chain. */
export function payRefOf(order: Order): string {
  return order.payRef ?? order.id;
}
