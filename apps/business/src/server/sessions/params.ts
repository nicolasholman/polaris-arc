import "server-only";

import type { CheckoutMode, SubscriptionInterval } from "@polaris/db";

import { formatCents, parseCents } from "../chain/money";
import { HttpError } from "../http";

/**
 * Validate `POST /api/v1/checkout/sessions` exactly as polarispay-sdk's
 * `buildCreateBody` does, so a request the SDK accepts is accepted here and
 * one it would refuse is refused with the same `code` and `param`. The API
 * is also callable without the SDK, so every rule is enforced here too.
 */

export type CreateSessionInput = {
  amountCents: number;
  description: string;
  lineItems: Array<{ name: string; quantity: number; unitAmountCents: number }>;
  modes: CheckoutMode[];
  subscription: { interval: SubscriptionInterval; intervalCount: number } | null;
  successUrl: string;
  cancelUrl: string | null;
  orderId: string | null;
  metadata: Record<string, string>;
};

export const MODES: readonly CheckoutMode[] = ["now", "later", "subscribe"];
const INTERVALS: readonly SubscriptionInterval[] = ["day", "week", "month", "year"];
const MAX_AMOUNT_CENTS = 1_000_000_00;
const MIN_AMOUNT_CENTS = 50;

function invalid(code: string, message: string, param?: string): never {
  throw new HttpError(400, code, message, { param });
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function url(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid("missing_url", `${param} is required: an absolute https URL.`, param);
  if (value.length > 2048) invalid("invalid_url", `${param} can be at most 2048 characters.`, param);
  let parsed: URL;
  try {
    parsed = new URL(value.replace("{CHECKOUT_SESSION_ID}", "cs_placeholder"));
  } catch {
    invalid("invalid_url", `${param} must be an absolute URL, got ${JSON.stringify(value)}.`, param);
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i.test(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    invalid("insecure_url", `${param} must use https (http is allowed for localhost only).`, param);
  }
  if (parsed.username || parsed.password) invalid("invalid_url", `${param} must not carry credentials.`, param);
  return value;
}

function amountCents(value: unknown, param: string): number {
  const cents = parseCents(value);
  if (cents === null) invalid("invalid_amount", `${param} must be a USD amount like "200.00", got ${JSON.stringify(value)}.`, param);
  return cents;
}

export function parseCreateSession(body: Record<string, unknown>): CreateSessionInput {
  const currency = body.currency ?? "USD";
  if (currency !== "USD") invalid("invalid_currency", 'currency must be "USD": every Polaris payment settles in AUSD, a dollar.', "currency");

  const description = body.description;
  if (typeof description !== "string" || description.trim() === "" || description.length > 500) {
    invalid("invalid_description", "description is required, up to 500 characters.", "description");
  }
  if (CONTROL.test(description)) invalid("invalid_description", "description contains control characters.", "description");

  const rawItems = body.lineItems ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > 100) invalid("invalid_line_items", "lineItems must be an array of at most 100 items.", "lineItems");
  let itemsTotal = 0;
  const lineItems = rawItems.map((raw, i) => {
    const param = `lineItems[${i}]`;
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== "object") invalid("invalid_line_item", `${param} must be an object.`, param);
    const name = item.name;
    if (typeof name !== "string" || name.trim() === "" || name.length > 200 || CONTROL.test(name)) {
      invalid("invalid_line_item", `${param}.name must be 1 to 200 characters.`, `${param}.name`);
    }
    const quantity = item.quantity ?? 1;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
      invalid("invalid_line_item", `${param}.quantity must be a whole number from 1 to 10000.`, `${param}.quantity`);
    }
    const unitAmountCents = amountCents(item.unitAmount, `${param}.unitAmount`);
    itemsTotal += unitAmountCents * quantity;
    return { name: name.trim(), quantity, unitAmountCents };
  });

  let cents: number;
  if (body.amount === undefined || body.amount === null) {
    if (lineItems.length === 0) invalid("missing_amount", "Pass amount, or lineItems to add up.", "amount");
    cents = itemsTotal;
  } else {
    cents = amountCents(body.amount, "amount");
    if (lineItems.length > 0 && cents !== itemsTotal) {
      invalid("amount_mismatch", `amount ${formatCents(cents)} doesn't match the line items, which add up to ${formatCents(itemsTotal)}.`, "amount");
    }
  }
  if (cents > MAX_AMOUNT_CENTS) invalid("amount_too_large", "amount can be at most 1000000.00.", "amount");
  if (cents < MIN_AMOUNT_CENTS) invalid("amount_too_small", "amount must be at least 0.50.", "amount");

  const rawModes = body.modes ?? ["now", "later"];
  if (!Array.isArray(rawModes) || rawModes.length === 0) invalid("invalid_modes", 'modes must list at least one of "now", "later", "subscribe".', "modes");
  for (const m of rawModes) {
    if (!MODES.includes(m as CheckoutMode)) invalid("invalid_modes", `Unknown mode ${JSON.stringify(m)}: use "now", "later" or "subscribe".`, "modes");
  }
  if (new Set(rawModes).size !== rawModes.length) invalid("invalid_modes", "modes has a duplicate.", "modes");
  const modes = rawModes as CheckoutMode[];

  let subscription: CreateSessionInput["subscription"] = null;
  if (modes.includes("subscribe")) {
    const terms = (body.subscription ?? { interval: "month" }) as Record<string, unknown>;
    if (typeof terms !== "object") invalid("invalid_subscription", "subscription must be an object.", "subscription");
    if (!INTERVALS.includes(terms.interval as SubscriptionInterval)) {
      invalid("invalid_subscription", 'subscription.interval must be "day", "week", "month" or "year".', "subscription.interval");
    }
    const intervalCount = terms.intervalCount ?? 1;
    if (typeof intervalCount !== "number" || !Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 12) {
      invalid("invalid_subscription", "subscription.intervalCount must be a whole number from 1 to 12.", "subscription.intervalCount");
    }
    subscription = { interval: terms.interval as SubscriptionInterval, intervalCount };
  } else if (body.subscription !== undefined && body.subscription !== null) {
    invalid("invalid_subscription", 'subscription only applies when modes includes "subscribe".', "subscription");
  }

  const orderId = body.orderId ?? null;
  if (orderId !== null && (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 200 || CONTROL.test(orderId))) {
    invalid("invalid_order_id", "orderId must be 1 to 200 characters.", "orderId");
  }

  const rawMeta = body.metadata ?? {};
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) invalid("invalid_metadata", "metadata must be an object of string values.", "metadata");
  const entries = Object.entries(rawMeta as Record<string, unknown>);
  if (entries.length > 20) invalid("invalid_metadata", "metadata can have at most 20 keys.", "metadata");
  const metadata: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length === 0 || k.length > 40) invalid("invalid_metadata", `metadata key ${JSON.stringify(k)} must be 1 to 40 characters.`, `metadata.${k}`);
    if (typeof v !== "string" || v.length > 500) invalid("invalid_metadata", `metadata.${k} must be a string of at most 500 characters.`, `metadata.${k}`);
    metadata[k] = v;
  }

  return {
    amountCents: cents,
    description: description.trim(),
    lineItems,
    modes: [...modes],
    subscription,
    successUrl: url(body.successUrl, "successUrl"),
    cancelUrl: body.cancelUrl === undefined || body.cancelUrl === null ? null : url(body.cancelUrl, "cancelUrl"),
    orderId: orderId as string | null,
    metadata,
  };
}

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,128}$/;

export function assertSessionId(id: string): string {
  if (!SESSION_ID.test(id)) throw new HttpError(404, "not_found", "No checkout session with that id.", { param: "id" });
  return id;
}

/** Seconds per subscription period. A month is 30 days, as the demo plans are. */
export function periodSeconds(terms: { interval: SubscriptionInterval; intervalCount: number }): number {
  const base = { day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 }[terms.interval];
  return base * terms.intervalCount;
}
