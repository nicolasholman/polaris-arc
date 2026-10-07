"use client";

import type { Order, SdkCall } from "@/lib/orders/types";

export type CheckoutPayload = {
  items: { productId: string; optionId: string; quantity: number }[];
  contact: { email: string; phone?: string };
  address: { name: string; line1: string; line2?: string; city: string; postalCode: string; country: string };
  payment: { method: "polaris"; mode: "now" | "later" | "subscribe" } | { method: "wallet" };
  /** The unpaid order this browser is already paying: the store continues it when only the way to pay changed. */
  continueOrder?: string;
};

export type CheckoutResponse = {
  order: { id: string; number: string; status: Order["status"]; total: number };
  reused: boolean;
  checkout?: { sessionId: string; url: string };
  /** What pay() needs. orderId is the order's payRef, the reference that goes on chain, not the order id. */
  wallet?: { merchant: `0x${string}`; amount: string; orderId: string };
};

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** FNV-1a, enough to tell two checkout payloads apart in an idempotency key. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function newAttemptId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * POST /api/checkout with an idempotency key made of this page visit and the
 * exact payload: a double click or a retry reuses the order and its Polaris
 * session, while changing anything (the mode, the address) starts a new one.
 */
export async function placeOrder(payload: CheckoutPayload, attemptId: string): Promise<CheckoutResponse> {
  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `hc_${attemptId}_${hash(body)}` },
      body,
    });
  } catch {
    throw new CheckoutError("We couldn't reach the store. Check your connection and try again.", "network");
  }
  const data = (await res.json().catch(() => null)) as (CheckoutResponse & { error?: { code: string; message: string; fields?: Record<string, string> } }) | null;
  if (!res.ok || !data || data.error) {
    throw new CheckoutError(data?.error?.message ?? "Something went wrong. Please try again.", data?.error?.code ?? `http_${res.status}`, data?.error?.fields);
  }
  return data;
}

/** Tell the store which browser SDK calls this checkout made, for the developer drawer. Best effort. */
export function logBrowserCalls(orderId: string, entries: Omit<SdkCall, "side">[]) {
  void fetch(`/api/orders/${orderId}/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entries),
    keepalive: true,
  }).catch(() => {});
}

export async function fetchOrder(orderId: string, sync = false): Promise<{ order: Order; session: { status: string; mode: string | null } | null } | null> {
  try {
    const res = await fetch(`/api/orders/${orderId}${sync ? "?sync=1" : ""}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as { order: Order; session: { status: string; mode: string | null } | null };
  } catch {
    return null;
  }
}
