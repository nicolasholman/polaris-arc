/**
 * polarispay-sdk's runtime event check (packages/sdk/src/event-shape.ts),
 * verbatim, importing the copied types beside it. test/sdk-copy.test.ts
 * fails if it drifts from the SDK's source.
 */

import { WEBHOOK_EVENT_TYPES, isWebhookEventType, type WebhookEvent, type WebhookEventType } from "./sdk-events.ts";

/**
 * A runtime check that an event is shaped exactly as `WebhookEvent` says:
 * the envelope, and every field of `data` for its type, with its format.
 *
 * `webhooks.verify` proves an event came from Polaris; it doesn't re-check
 * the payload. This does, for anything that *builds* events: the API's
 * webhook emitter, the indexer's outbox, a mock for your tests. The type
 * system can't catch an amount sent in base units ("25000000" for $25.00),
 * a currency of "ausd", or a mode of "PAY_NOW"; this does.
 *
 *   const problems = validateWebhookEvent(event);
 *   // [] when it matches; else [{ path: "data.amount", message: "…" }, …]
 */

export type WebhookEventProblem = {
  /** Where: "type", "data.amount", "data.schedule[2].dueAt". */
  path: string;
  message: string;
};

type Check = (value: unknown) => string | null;

const AMOUNT = /^\d+\.\d{2,6}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const amount: Check = (v) =>
  typeof v === "string" && AMOUNT.test(v)
    ? null
    : `must be a USD decimal string with 2 to 6 decimals ("25.00", "50.383562"), got ${show(v)}${
        typeof v === "string" && /^\d{7,}$/.test(v) ? ": this looks like AUSD base units" : ""
      }`;
const txHash: Check = (v) => (typeof v === "string" && TX_HASH.test(v) ? null : `must be a 32-byte 0x hash, got ${show(v)}`);
const address: Check = (v) => (typeof v === "string" && ADDRESS.test(v) ? null : `must be a 0x address, got ${show(v)}`);
const text: Check = (v) => (typeof v === "string" && v.length > 0 ? null : `must be a non-empty string, got ${show(v)}`);
const count: Check = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? null : `must be a whole number, got ${show(v)}`);
const positive: Check = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? null : `must be a whole number from 1, got ${show(v)}`);
const iso: Check = (v) =>
  typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? null : `must be an ISO 8601 UTC time ("2026-10-01T12:00:00.000Z"), got ${show(v)}`;
const bool: Check = (v) => (typeof v === "boolean" ? null : `must be true or false, got ${show(v)}`);
const orNull =
  (check: Check): Check =>
  (v) => {
    if (v === null) return null;
    const message = check(v);
    return message ? `${message} (or null)` : null;
  };
const oneOf =
  (...allowed: readonly string[]): Check =>
  (v) =>
    typeof v === "string" && allowed.includes(v) ? null : `must be ${allowed.map((a) => JSON.stringify(a)).join(" or ")}, got ${show(v)}`;
const metadata: Check = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")
    ? null
    : `must be an object of strings, got ${show(v)}`;

function show(v: unknown): string {
  if (v === undefined) return "nothing";
  try {
    const json = JSON.stringify(v);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  } catch {
    return typeof v;
  }
}

type Shape = Record<string, Check>;

const ON_CHAIN: Shape = { txHash, chainId: positive };
const ORDER_REF: Shape = { orderId: text, sessionId: orNull(text), metadata };

const SHAPES: Record<WebhookEventType, Shape> = {
  "payment.succeeded": {
    ...ON_CHAIN,
    ...ORDER_REF,
    paymentId: txHash,
    mode: oneOf("now"),
    merchant: address,
    payer: address,
    amount,
    fee: amount,
    currency: oneOf("USD"),
  },
  "plan.opened": {
    ...ON_CHAIN,
    ...ORDER_REF,
    planId: text,
    mode: oneOf("later"),
    merchant: address,
    borrower: address,
    principal: amount,
    interest: amount,
    total: amount,
    installments: positive,
    intervalSeconds: positive,
    currency: oneOf("USD"),
    // `schedule` is checked row by row below.
  },
  "installment.collected": {
    ...ON_CHAIN,
    planId: text,
    orderId: text,
    installment: positive,
    installments: positive,
    amount,
    remaining: amount,
  },
  "installment.failed": {
    planId: text,
    orderId: text,
    installment: positive,
    amount,
    reason: oneOf("insufficient_funds", "allowance_lost", "other"),
    attempt: positive,
    nextAttemptAt: orNull(iso),
    chainId: positive,
  },
  "plan.completed": { ...ON_CHAIN, planId: text, orderId: text, total: amount },
  "plan.liquidated": { ...ON_CHAIN, planId: text, orderId: text, outstanding: amount, recovered: amount },
  "subscription.charged": {
    ...ON_CHAIN,
    subscriptionId: text,
    planId: text,
    merchant: address,
    subscriber: address,
    amount,
    fee: amount,
    period: positive,
    nextChargeAt: iso,
    orderId: orNull(text),
    sessionId: orNull(text),
  },
  "subscription.canceled": {
    ...ON_CHAIN,
    subscriptionId: text,
    planId: text,
    merchant: address,
    subscriber: address,
    canceledBy: oneOf("subscriber", "merchant", "lapsed"),
  },
  "payout.paid": { ...ON_CHAIN, payoutId: text, amount, destination: address, automatic: bool },
};

const SCHEDULE_ROW: Shape = { index: positive, amount, dueAt: iso };

function checkShape(value: Record<string, unknown>, shape: Shape, prefix: string, out: WebhookEventProblem[]): void {
  for (const [key, check] of Object.entries(shape)) {
    const message = check(value[key]);
    if (message) out.push({ path: `${prefix}${key}`, message });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every way `event` differs from the `WebhookEvent` it claims to be, or `[]`
 * when it matches. Extra fields are allowed: events may grow.
 */
export function validateWebhookEvent(event: unknown): WebhookEventProblem[] {
  const out: WebhookEventProblem[] = [];
  if (!isObject(event)) return [{ path: "", message: `must be an event object, got ${show(event)}` }];

  if (typeof event.id !== "string" || !event.id.startsWith("evt_")) out.push({ path: "id", message: `must be an event id ("evt_…"), got ${show(event.id)}` });
  if (event.object !== "event") out.push({ path: "object", message: `must be "event", got ${show(event.object)}` });
  const createdAt = iso(event.createdAt);
  if (createdAt) out.push({ path: "createdAt", message: createdAt });
  if (typeof event.livemode !== "boolean") out.push({ path: "livemode", message: `must be true or false, got ${show(event.livemode)}` });
  if (typeof event.merchantId !== "string" || !event.merchantId.startsWith("mer_")) {
    out.push({ path: "merchantId", message: `must be the merchant's public id ("mer_…"), got ${show(event.merchantId)}` });
  }
  if (!isWebhookEventType(event.type)) {
    out.push({ path: "type", message: `must be one of ${WEBHOOK_EVENT_TYPES.join(", ")}; got ${show(event.type)}` });
    return out;
  }
  if (!isObject(event.data)) {
    out.push({ path: "data", message: `must be an object, got ${show(event.data)}` });
    return out;
  }

  const data = event.data;
  checkShape(data, SHAPES[event.type], "data.", out);

  if (event.type === "plan.opened") {
    if (!Array.isArray(data.schedule)) {
      out.push({ path: "data.schedule", message: `must be a list of instalments, got ${show(data.schedule)}` });
    } else {
      if (typeof data.installments === "number" && data.schedule.length !== data.installments) {
        out.push({ path: "data.schedule", message: `has ${data.schedule.length} rows for ${data.installments} instalments` });
      }
      data.schedule.forEach((row, i) => {
        if (!isObject(row)) out.push({ path: `data.schedule[${i}]`, message: `must be an object, got ${show(row)}` });
        else checkShape(row, SCHEDULE_ROW, `data.schedule[${i}].`, out);
      });
    }
  }
  return out;
}

/** `validateWebhookEvent`, throwing a TypeError that lists every problem. */
export function assertWebhookEvent(event: unknown): asserts event is WebhookEvent {
  const problems = validateWebhookEvent(event);
  if (problems.length > 0) {
    const type = isObject(event) && typeof event.type === "string" ? event.type : "event";
    throw new TypeError(`Not a well-formed ${type}:\n${problems.map((p) => `  ${p.path || "(event)"} ${p.message}`).join("\n")}`);
  }
}
