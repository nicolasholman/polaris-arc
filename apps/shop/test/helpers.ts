import type { WebhookEvent, WebhookEventDataMap, WebhookEventType } from "polarispay-sdk";
import { signWebhookPayload } from "polarispay-sdk/server";

import { parseCheckoutRequest, type PricedCheckout } from "@/lib/orders/checkout-request";
import type { Order } from "@/lib/orders/types";

export const SECRET = "whsec_test_secret_for_the_shop";

let counter = 0;
/** A webhook event exactly as polarispay-sdk 0.3.0 types it. */
export function event<K extends WebhookEventType>(type: K, data: WebhookEventDataMap[K], createdAt = new Date().toISOString()): WebhookEvent {
  counter += 1;
  return {
    id: `evt_test_${counter}_${Math.random().toString(36).slice(2, 8)}`,
    object: "event",
    type,
    createdAt,
    livemode: false,
    merchantId: "mer_test",
    data,
  } as WebhookEvent;
}

export function signed(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  return signWebhookPayload(body, secret, timestamp);
}

export const TX = `0x${"ab".repeat(32)}` as const;
export const ADDR = `0x${"12".repeat(20)}` as const;

export const BUYER = {
  contact: { email: "lena@example.com" },
  address: { name: "Lena Hartmann", line1: "Torstraße 118", city: "Berlin", postalCode: "10119", country: "Germany" },
};

export function checkoutBody(payment: unknown = { method: "polaris", mode: "later" }, items: unknown = [{ productId: "halcyon-one", optionId: "graphite", quantity: 1 }]) {
  return { items, ...BUYER, payment };
}

export function priced(payment: unknown = { method: "polaris", mode: "later" }, items?: unknown): PricedCheckout {
  const parsed = parseCheckoutRequest(checkoutBody(payment, items));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

export function baseOrder(overrides: Partial<Order> = {}): Order {
  const now = new Date().toISOString();
  return {
    id: "hc_testorder000000000001",
    number: "HC-10001",
    createdAt: now,
    updatedAt: now,
    status: "awaiting_payment",
    kind: "one_time",
    lines: [
      {
        productId: "halcyon-one",
        optionId: "graphite",
        name: "Halcyon One",
        optionLabel: "Colour",
        optionValue: "Graphite",
        image: "/products/headphones.png",
        unitPrice: 34900,
        quantity: 1,
      },
    ],
    subtotal: 34900,
    shipping: 0,
    total: 34900,
    contact: { email: "lena@example.com" },
    address: BUYER.address,
    payment: { method: "polaris", requestedMode: "later", sessionAttempt: 0, sessionId: "cs_test_1" },
    events: [],
    sdkLog: [],
    ...overrides,
  };
}
