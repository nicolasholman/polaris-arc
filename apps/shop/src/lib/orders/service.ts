import { randomBytes, randomInt } from "node:crypto";

import type { CheckoutSession, WebhookEvent as PolarisEvent } from "polarispay-sdk";

import { canRead, newAccessToken } from "./access";
import { fingerprint, type PricedCheckout } from "./checkout-request";
import { orderStore, type OrderStore } from "./store";
import { applyEvent, isOrderEvent, orderIdForEvent, type ApplyOptions, type ApplyOutcome } from "./transitions";
import type { Order, SdkCall } from "./types";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function random32(prefix: string): string {
  const bytes = randomBytes(20);
  let id = prefix;
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}

/** The order's id on this store (/orders/{id}). 20 base32 characters is 100 bits. */
export function newOrderId(): string {
  return random32("hc_");
}

/**
 * The reference Polaris and the chain see (the session's orderId, and the
 * orderId a direct wallet payment signs for). Unguessable, since a guessable
 * one could be paid for a cent before the buyer pays it, and never the order
 * id, since it is written on chain for anyone to index.
 */
export function newPayRef(): string {
  return random32("hcp_");
}

/** What the buyer reads: HC-40218. */
export function newOrderNumber(): string {
  return `HC-${randomInt(10_000, 99_999)}`;
}

export type CreateOrderResult = { ok: true; order: Order; reused: boolean; switched?: boolean } | { ok: false; conflict: true };

/** The same goods, buyer and total: what an order must still be for the buyer to go on paying it another way. */
function sameGoods(order: Order, checkout: PricedCheckout): boolean {
  const goods = (lines: { productId: string; optionId: string; quantity: number }[]) =>
    JSON.stringify(lines.map((l) => [l.productId, l.optionId, l.quantity]));
  return (
    order.kind === checkout.kind &&
    order.total === checkout.total &&
    goods(order.lines) === goods(checkout.lines) &&
    JSON.stringify(order.contact) === JSON.stringify(checkout.contact) &&
    JSON.stringify(order.address) === JSON.stringify(checkout.address)
  );
}

/**
 * Create the order for a checkout, once per idempotency key. The same key
 * with the same request returns the same order (a double click, a retry after
 * a dropped response); the same key with a different request is a conflict.
 *
 * `continueOrder` is the order this browser was already paying for (it holds
 * the order's access token). If it's still unpaid and for the same goods, the
 * buyer is only changing how they pay, so that order is reused with the new
 * method: a direct payment then signs for the same payRef, which
 * PolarisPayments refuses to take twice, instead of opening a second order
 * that could be paid on top of the first.
 */
export function createOrder(
  checkout: PricedCheckout,
  idempotencyKey: string | null,
  store: OrderStore = orderStore(),
  now: Date = new Date(),
  continueOrder: { id: string; token: string | null } | null = null,
): Promise<CreateOrderResult> {
  return store.update((data) => {
    const print = fingerprint(checkout);
    if (idempotencyKey) {
      const prior = data.idempotency[idempotencyKey];
      if (prior) {
        if (prior.fingerprint !== print) return { ok: false as const, conflict: true as const };
        const existing = data.orders[prior.orderId];
        if (existing) return { ok: true as const, order: existing, reused: true };
      }
    }
    const at = now.toISOString();

    const current = continueOrder ? data.orders[continueOrder.id] : undefined;
    if (current && current.status === "awaiting_payment" && canRead(current, continueOrder?.token) && sameGoods(current, checkout)) {
      current.payment.method = checkout.payment.method;
      if (checkout.payment.method === "polaris") current.payment.requestedMode = checkout.payment.mode;
      else delete current.payment.requestedMode;
      current.updatedAt = at;
      if (idempotencyKey) data.idempotency[idempotencyKey] = { orderId: current.id, fingerprint: print, createdAt: at };
      return { ok: true as const, order: current, reused: true, switched: true };
    }

    const order: Order = {
      id: newOrderId(),
      payRef: newPayRef(),
      accessToken: newAccessToken(),
      number: newOrderNumber(),
      createdAt: at,
      updatedAt: at,
      status: "awaiting_payment",
      kind: checkout.kind,
      lines: checkout.lines,
      subtotal: checkout.subtotal,
      shipping: checkout.shipping,
      total: checkout.total,
      contact: checkout.contact,
      address: checkout.address,
      payment: {
        method: checkout.payment.method,
        ...(checkout.payment.method === "polaris" ? { requestedMode: checkout.payment.mode } : {}),
        sessionAttempt: 0,
      },
      events: [],
      sdkLog: [],
    };
    data.orders[order.id] = order;
    if (idempotencyKey) data.idempotency[idempotencyKey] = { orderId: order.id, fingerprint: print, createdAt: at };
    return { ok: true as const, order, reused: false };
  });
}

export async function getOrder(id: string, store: OrderStore = orderStore()): Promise<Order | null> {
  const data = await store.read();
  return data.orders[id] ?? null;
}

/** The order a Polaris reference (the payRef, or an older order's id) belongs to. */
export async function getOrderByRef(ref: string, store: OrderStore = orderStore()): Promise<Order | null> {
  const data = await store.read();
  return data.orders[ref] ?? Object.values(data.orders).find((o) => o.payRef === ref) ?? null;
}

/** An open session for the same mode that hasn't expired can be reopened instead of creating another. */
export function reusableSession(order: Order, now: Date = new Date()): { id: string; url: string } | null {
  const { sessionId, sessionUrl, sessionExpiresAt, sessionMode, requestedMode } = order.payment;
  if (!sessionId || !sessionUrl || !sessionExpiresAt) return null;
  if (sessionMode && requestedMode && sessionMode !== requestedMode) return null;
  return new Date(sessionExpiresAt).getTime() - now.getTime() > 60_000 ? { id: sessionId, url: sessionUrl } : null;
}

/** Bump the attempt counter before creating a new session, so its idempotency key is new. */
export function nextSessionAttempt(orderId: string, store: OrderStore = orderStore()): Promise<Order | null> {
  return store.update((data) => {
    const order = data.orders[orderId];
    if (!order) return null;
    if (order.payment.sessionId) order.payment.sessionAttempt += 1;
    return order;
  });
}

export function attachSession(orderId: string, session: CheckoutSession, log: SdkCall, store: OrderStore = orderStore()) {
  return store.update((data) => {
    const order = data.orders[orderId];
    if (!order) return null;
    order.payment.sessionId = session.id;
    order.payment.sessionUrl = session.url;
    order.payment.sessionExpiresAt = session.expiresAt;
    order.payment.sessionMode = order.payment.requestedMode;
    order.sdkLog.push(log);
    order.updatedAt = new Date().toISOString();
    return order;
  });
}

export function appendSdkLog(orderId: string, entries: SdkCall[], store: OrderStore = orderStore()) {
  return store.update((data) => {
    const order = data.orders[orderId];
    if (!order) return null;
    order.sdkLog.push(...entries);
    order.sdkLog = order.sdkLog.slice(-60);
    return order;
  });
}

/** How many browser calls one order's log may hold: a checkout makes a handful. */
export const MAX_BROWSER_LOG = 12;

/** How long after payment the checkout may still report its calls: the popup's result lands after the webhook. */
export const BROWSER_LOG_GRACE_MS = 15 * 60_000;

/**
 * The browser's own SDK calls, for the developer drawer: only while the order
 * is unpaid or just paid (that's when a checkout makes them, and the popup's
 * result often lands after the webhook), and only up to a handful.
 */
export function appendBrowserLog(orderId: string, entries: SdkCall[], store: OrderStore = orderStore(), now: Date = new Date()) {
  return store.update((data) => {
    const order = data.orders[orderId];
    if (!order) return { ok: false as const, reason: "not_found" as const };
    const paidAt = order.payment.paidAt ? new Date(order.payment.paidAt).getTime() : null;
    const open = order.status === "awaiting_payment" || (paidAt !== null && now.getTime() - paidAt < BROWSER_LOG_GRACE_MS);
    if (!open) return { ok: false as const, reason: "closed" as const };
    const room = MAX_BROWSER_LOG - order.sdkLog.filter((c) => c.side === "browser").length;
    const accepted = entries.slice(0, Math.max(0, room));
    order.sdkLog.push(...accepted);
    order.sdkLog = order.sdkLog.slice(-60);
    return { ok: true as const, recorded: accepted.length };
  });
}

/** One sessions.retrieve per order every 10 seconds, and only while it's unpaid. */
export const SYNC_INTERVAL_MS = 10_000;

/** Whether the store may ask Polaris about this order's session now; claims the slot if so. */
export function claimSync(orderId: string, store: OrderStore = orderStore(), now: Date = new Date()): Promise<boolean> {
  return store.update((data) => {
    const order = data.orders[orderId];
    if (!order || order.status !== "awaiting_payment" || !order.payment.sessionId) return false;
    const last = order.payment.lastSyncedAt ? new Date(order.payment.lastSyncedAt).getTime() : 0;
    if (now.getTime() - last < SYNC_INTERVAL_MS) return false;
    order.payment.lastSyncedAt = now.toISOString();
    return true;
  });
}

/** Log a retrieve only when it says something new, so polling doesn't flood the drawer. */
export function logRetrieve(orderId: string, entry: SdkCall, store: OrderStore = orderStore()) {
  return store.update((data) => {
    const order = data.orders[orderId];
    if (!order) return null;
    const previous = [...order.sdkLog].reverse().find((c) => c.call === entry.call);
    if (previous && JSON.stringify(previous.result) === JSON.stringify(entry.result)) return order;
    order.sdkLog.push(entry);
    order.sdkLog = order.sdkLog.slice(-60);
    return order;
  });
}

export type WebhookOutcome = ApplyOutcome | "ignored";

/**
 * Apply one verified event. The status code is what the webhook route
 * answers: 2xx for anything Polaris shouldn't send again (repeats, and
 * merchant-level events like payouts), 409 for an event that arrived before
 * the one it depends on, and 404 for an order event that matches no order
 * here. Neither of the last two is remembered, so Polaris redelivers them: a
 * payment is never dropped because the store hadn't stored its order yet.
 */
export function recordEvent(
  event: PolarisEvent,
  store: OrderStore = orderStore(),
  now: Date = new Date(),
  options: ApplyOptions = {},
): Promise<{ status: number; outcome: WebhookOutcome; orderId: string | null; reason?: string }> {
  return store.update((data) => {
    if (data.events[event.id]) {
      return { status: 200, outcome: "duplicate" as const, orderId: data.events[event.id]!.orderId };
    }
    const remember = (orderId: string | null) => {
      data.events[event.id] = { type: event.type, receivedAt: now.toISOString(), orderId };
    };
    if (!isOrderEvent(event)) {
      remember(null);
      return { status: 200, outcome: "ignored" as const, orderId: null };
    }

    // The event names the order by the payRef the shop gave Polaris; orders from before payRef used their id.
    const named = orderIdForEvent(event);
    let orderId: string | null = named && data.orders[named] ? named : (Object.values(data.orders).find((o) => named && o.payRef === named)?.id ?? null);
    if (!orderId) {
      // Fall back to what the store saw earlier: the session, the plan, the subscription.
      const ref = event.data as { sessionId?: string | null; planId?: string; subscriptionId?: string };
      const found = Object.values(data.orders).find(
        (o) =>
          (ref.sessionId && o.payment.sessionId === ref.sessionId) ||
          (ref.planId && o.plan?.planId === ref.planId) ||
          (ref.subscriptionId && o.subscription?.subscriptionId === ref.subscriptionId),
      );
      orderId = found?.id ?? null;
    }
    const order = orderId ? data.orders[orderId] : undefined;
    if (!order) {
      // Only a Halcyon payRef (hcp_…) can be an order this store hasn't saved yet: answer 404 so Polaris
      // retries it. Anything else (a dashboard payment link's payment, the dashboard's "Send test event")
      // was never a Halcyon order: acknowledge it once, so Polaris doesn't retry it for 34 hours.
      const test = (event.data as { metadata?: { test?: unknown } }).metadata?.test === "true" || Boolean(named?.startsWith("ord_test_"));
      if (test || !named?.startsWith("hcp_")) {
        remember(null);
        return { status: 200, outcome: "ignored" as const, orderId: null, reason: test ? "A test event." : "Not a Halcyon order." };
      }
      return { status: 404, outcome: "ignored" as const, orderId: null, reason: "No order matches this event." };
    }

    const result = applyEvent(order, event, now, options);
    if (result.outcome === "retry") return { status: 409, outcome: "retry" as const, orderId: order.id, reason: result.reason };
    data.orders[order.id] = result.order;
    remember(order.id);
    return { status: 200, outcome: result.outcome, orderId: order.id, reason: result.reason };
  });
}
