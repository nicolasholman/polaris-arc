import { FLAT_SHIPPING, FREE_SHIPPING_THRESHOLD, getOption, getProduct } from "@/lib/catalog";
import type { CheckoutMode } from "polarispay-sdk";

import type { Address, Contact, OrderLine } from "./types";

/**
 * What the checkout page posts to /api/checkout, validated and priced on the
 * server. The browser sends ids and quantities; every price comes from the
 * catalogue here.
 */

export type CheckoutPayment = { method: "polaris"; mode: CheckoutMode } | { method: "wallet" };

export interface CheckoutRequest {
  items: { productId: string; optionId: string; quantity: number }[];
  contact: Contact;
  address: Address;
  payment: CheckoutPayment;
}

export interface PricedCheckout extends CheckoutRequest {
  kind: "one_time" | "subscription";
  lines: OrderLine[];
  subtotal: number;
  shipping: number;
  total: number;
}

export type ParseResult = { ok: true; value: PricedCheckout } | { ok: false; errors: Record<string, string> };

const MAX_LINES = 20;
const MAX_QUANTITY = 10;
/** The smallest order Pay in 4 is offered on. */
export const PAY_IN_4_MINIMUM = 5000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export function parseCheckoutRequest(body: unknown): ParseResult {
  const errors: Record<string, string> = {};
  const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  // Items
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) errors.items = "Your bag is empty.";
  if (rawItems.length > MAX_LINES) errors.items = "That's more lines than one order can hold.";
  const items: CheckoutRequest["items"] = [];
  const lines: OrderLine[] = [];
  rawItems.slice(0, MAX_LINES).forEach((raw, i) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const product = typeof item.productId === "string" ? getProduct(item.productId) : undefined;
    const option = product && typeof item.optionId === "string" ? getOption(product, item.optionId) : undefined;
    const quantity = item.quantity;
    if (!product || !option) {
      errors[`items.${i}`] = "One of the items is no longer available.";
      return;
    }
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      errors[`items.${i}`] = `Choose a quantity from 1 to ${MAX_QUANTITY}.`;
      return;
    }
    items.push({ productId: product.id, optionId: option.id, quantity });
    lines.push({
      productId: product.id,
      optionId: option.id,
      name: product.name,
      optionLabel: product.optionLabel,
      optionValue: option.label,
      image: product.image,
      unitPrice: product.price,
      quantity,
      recurring: product.recurring?.interval,
    });
  });

  const recurring = lines.filter((l) => l.recurring);
  const kind: PricedCheckout["kind"] = recurring.length > 0 ? "subscription" : "one_time";
  if (recurring.length > 0 && (lines.length !== 1 || recurring[0]!.quantity !== 1)) {
    errors.items = "The Coffee Club checks out on its own, one subscription at a time.";
  }

  // Contact and address
  const contactIn = (input.contact ?? {}) as Record<string, unknown>;
  const addressIn = (input.address ?? {}) as Record<string, unknown>;
  const email = text(contactIn.email, 254);
  if (!email || !EMAIL.test(email)) errors["contact.email"] = "Enter an email address like name@example.com.";
  const phone = contactIn.phone === undefined || contactIn.phone === "" ? undefined : text(contactIn.phone, 40);
  if (phone === null) errors["contact.phone"] = "Enter a phone number, or leave it empty.";

  const address: Partial<Address> = {};
  for (const [field, label, max] of [
    ["name", "your name", 80],
    ["line1", "a street address", 120],
    ["city", "a city", 80],
    ["postalCode", "a postcode", 20],
    ["country", "a country", 60],
  ] as const) {
    const value = text(addressIn[field], max);
    if (!value) errors[`address.${field}`] = `Enter ${label}.`;
    else address[field] = value;
  }
  const line2 = addressIn.line2 === undefined || addressIn.line2 === "" ? undefined : text(addressIn.line2, 120);
  if (line2 === null) errors["address.line2"] = "That line is too long.";

  // Totals
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const shipping = kind === "subscription" || subtotal >= FREE_SHIPPING_THRESHOLD || subtotal === 0 ? 0 : FLAT_SHIPPING;
  const total = subtotal + shipping;

  // Payment
  const paymentIn = (input.payment ?? {}) as Record<string, unknown>;
  let payment: CheckoutPayment | null = null;
  if (paymentIn.method === "wallet") {
    payment = { method: "wallet" };
    if (kind === "subscription") errors.payment = "Subscriptions renew through Polaris. Choose Polaris to subscribe.";
  } else if (paymentIn.method === "polaris" && (paymentIn.mode === "now" || paymentIn.mode === "later" || paymentIn.mode === "subscribe")) {
    payment = { method: "polaris", mode: paymentIn.mode };
    if (kind === "subscription" && paymentIn.mode !== "subscribe") errors.payment = "The Coffee Club is a subscription. Choose Subscribe.";
    if (kind === "one_time" && paymentIn.mode === "subscribe") errors.payment = "Nothing in your bag renews. Choose Pay now or Pay in 4.";
    if (paymentIn.mode === "later" && total < PAY_IN_4_MINIMUM) errors.payment = "Pay in 4 starts at $50.";
  } else {
    errors.payment = "Choose how you'd like to pay.";
  }

  if (Object.keys(errors).length > 0 || !payment) return { ok: false, errors };
  return {
    ok: true,
    value: {
      items,
      contact: { email: email!, ...(phone ? { phone } : {}) },
      address: { ...(address as Address), ...(line2 ? { line2 } : {}) },
      payment,
      kind,
      lines,
      subtotal,
      shipping,
      total,
    },
  };
}

/** A stable fingerprint of a request, so a reused idempotency key with a different body is caught. */
export function fingerprint(value: PricedCheckout): string {
  return JSON.stringify({
    items: value.items,
    contact: value.contact,
    address: value.address,
    payment: value.payment,
  });
}
