import type { CheckoutSessionCreateParams, LineItem, SubscriptionInterval } from "../checkout/types.js";
import { invalidRequest } from "../errors.js";
import { formatCents, toCents } from "../money.js";
import { CHECKOUT_MODES, type CheckoutMode } from "../types.js";

/**
 * Check a session's parameters before they leave the server, and put them in
 * the canonical form the API receives. The API validates again; this is so a
 * typo fails in your test run with a message naming the field, not as a 400
 * from production.
 */

/** Exactly the JSON body of POST /api/v1/checkout/sessions. */
export type CheckoutSessionCreateBody = {
  amount: string;
  currency: "USD";
  description: string;
  lineItems: Array<{ name: string; quantity: number; unitAmount: string }>;
  modes: CheckoutMode[];
  subscription: { interval: SubscriptionInterval; intervalCount: number } | null;
  successUrl: string;
  cancelUrl: string | null;
  orderId: string | null;
  metadata: Record<string, string>;
};

const INTERVALS: readonly SubscriptionInterval[] = ["day", "week", "month", "year"];
const MAX_AMOUNT_CENTS = 1_000_000_00n; // $1,000,000

function url(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidRequest("missing_url", `${param} is required: an absolute https URL.`, param);
  }
  // `{CHECKOUT_SESSION_ID}` is substituted by the API; it must survive URL parsing.
  let parsed: URL;
  try {
    parsed = new URL(value.replace("{CHECKOUT_SESSION_ID}", "cs_placeholder"));
  } catch {
    throw invalidRequest("invalid_url", `${param} must be an absolute URL, got ${JSON.stringify(value)}.`, param);
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i.test(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw invalidRequest("insecure_url", `${param} must use https (http is allowed for localhost only).`, param);
  }
  return value;
}

function lineItems(items: LineItem[] | undefined): { items: CheckoutSessionCreateBody["lineItems"]; totalCents: bigint } {
  if (items === undefined) return { items: [], totalCents: 0n };
  if (!Array.isArray(items) || items.length > 100) {
    throw invalidRequest("invalid_line_items", "lineItems must be an array of at most 100 items.", "lineItems");
  }
  let totalCents = 0n;
  const out = items.map((item, i) => {
    const param = `lineItems[${i}]`;
    if (!item || typeof item.name !== "string" || item.name.trim() === "" || item.name.length > 200) {
      throw invalidRequest("invalid_line_item", `${param}.name must be 1 to 200 characters.`, `${param}.name`);
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
      throw invalidRequest("invalid_line_item", `${param}.quantity must be a whole number from 1 to 10000.`, `${param}.quantity`);
    }
    const unit = toCents(item.unitAmount, `${param}.unitAmount`);
    totalCents += unit * BigInt(quantity);
    return { name: item.name.trim(), quantity, unitAmount: formatCents(unit) };
  });
  return { items: out, totalCents };
}

function metadata(value: Record<string, string> | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("invalid_metadata", "metadata must be an object of string values.", "metadata");
  }
  const entries = Object.entries(value);
  if (entries.length > 20) throw invalidRequest("invalid_metadata", "metadata can have at most 20 keys.", "metadata");
  for (const [k, v] of entries) {
    if (k.length === 0 || k.length > 40) throw invalidRequest("invalid_metadata", `metadata key ${JSON.stringify(k)} must be 1 to 40 characters.`, `metadata.${k}`);
    if (typeof v !== "string" || v.length > 500) {
      throw invalidRequest("invalid_metadata", `metadata.${k} must be a string of at most 500 characters.`, `metadata.${k}`);
    }
  }
  return { ...value };
}

export function buildCreateBody(params: CheckoutSessionCreateParams): CheckoutSessionCreateBody {
  if (!params || typeof params !== "object") {
    throw invalidRequest("invalid_params", "checkout.sessions.create takes an object of parameters.");
  }
  const currency = params.currency ?? "USD";
  if (currency !== "USD") {
    throw invalidRequest("invalid_currency", 'currency must be "USD": every Polaris payment settles in AUSD, a dollar.', "currency");
  }
  if (typeof params.description !== "string" || params.description.trim() === "" || params.description.length > 500) {
    throw invalidRequest("invalid_description", "description is required, up to 500 characters.", "description");
  }

  const { items, totalCents } = lineItems(params.lineItems);
  let amountCents: bigint;
  if (params.amount === undefined) {
    if (items.length === 0) throw invalidRequest("missing_amount", "Pass amount, or lineItems to add up.", "amount");
    amountCents = totalCents;
  } else {
    amountCents = toCents(params.amount);
    if (items.length > 0 && amountCents !== totalCents) {
      throw invalidRequest(
        "amount_mismatch",
        `amount ${formatCents(amountCents)} doesn't match the line items, which add up to ${formatCents(totalCents)}.`,
        "amount",
      );
    }
  }
  if (amountCents > MAX_AMOUNT_CENTS) throw invalidRequest("amount_too_large", "amount can be at most 1000000.00.", "amount");

  const modes = params.modes ?? ["now", "later"];
  if (!Array.isArray(modes) || modes.length === 0) {
    throw invalidRequest("invalid_modes", 'modes must list at least one of "now", "later", "subscribe".', "modes");
  }
  for (const m of modes) {
    if (!CHECKOUT_MODES.includes(m)) {
      throw invalidRequest("invalid_modes", `Unknown mode ${JSON.stringify(m)}: use "now", "later" or "subscribe".`, "modes");
    }
  }
  if (new Set(modes).size !== modes.length) throw invalidRequest("invalid_modes", "modes has a duplicate.", "modes");

  let subscription: CheckoutSessionCreateBody["subscription"] = null;
  if (modes.includes("subscribe")) {
    const terms = params.subscription ?? { interval: "month" as const };
    if (!INTERVALS.includes(terms.interval)) {
      throw invalidRequest("invalid_subscription", 'subscription.interval must be "day", "week", "month" or "year".', "subscription.interval");
    }
    const intervalCount = terms.intervalCount ?? 1;
    if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 12) {
      throw invalidRequest("invalid_subscription", "subscription.intervalCount must be a whole number from 1 to 12.", "subscription.intervalCount");
    }
    subscription = { interval: terms.interval, intervalCount };
  } else if (params.subscription !== undefined) {
    throw invalidRequest("invalid_subscription", 'subscription only applies when modes includes "subscribe".', "subscription");
  }

  if (params.orderId !== undefined && (typeof params.orderId !== "string" || params.orderId.length === 0 || params.orderId.length > 200)) {
    throw invalidRequest("invalid_order_id", "orderId must be 1 to 200 characters.", "orderId");
  }

  return {
    amount: formatCents(amountCents),
    currency: "USD",
    description: params.description.trim(),
    lineItems: items,
    modes: [...modes],
    subscription,
    successUrl: url(params.successUrl, "successUrl"),
    cancelUrl: params.cancelUrl === undefined ? null : url(params.cancelUrl, "cancelUrl"),
    orderId: params.orderId ?? null,
    metadata: metadata(params.metadata),
  };
}

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,128}$/;

export function assertSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw invalidRequest("invalid_session_id", `Not a checkout session id: ${JSON.stringify(id)}. They look like cs_test_… or cs_live_….`, "id");
  }
  return id;
}
