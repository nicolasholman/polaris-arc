import "server-only";

import { getAddress, isAddress, zeroAddress } from "viem";

import { money } from "@/lib/data/format";
import {
  WEBHOOK_EVENTS,
  type Address,
  type AutoPayoutsInput,
  type CreateApiKeyInput,
  type CreateLinkInput,
  type CreateWebhookInput,
  type LinkUsage,
  type PayMode,
  type UpdateLinkInput,
  type WebhookEventType,
  type WithdrawInput,
} from "@/lib/data/types";
import { HttpError } from "./http";

/**
 * Request validation. Each function takes the parsed JSON body and returns a
 * typed input or throws a 400 whose message a person can act on, plus the
 * `param` it is about (the field's code name, for the client to mark; never
 * in the message).
 */

function invalid(message: string, param?: string): never {
  throw new HttpError(400, "invalid_request", message, { param });
}

type TextRule = { min?: number; max?: number; name: string };

function text(body: Record<string, unknown>, key: string, { min = 1, max = 200, name }: TextRule): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) invalid(`Enter ${name}.`, key);
  const trimmed = value.trim();
  if (trimmed.length < min) invalid(`Use at least ${min} characters.`, key);
  if (trimmed.length > max) invalid(`Keep it to ${max} characters or fewer.`, key);
  // No control characters: these end up in receipts, webhooks and logs.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) invalid("Remove the line breaks or special characters.", key);
  return trimmed;
}

/** Whole cents, $1.00 to $1,000,000.00 unless a tighter cap applies. */
function cents(body: Record<string, unknown>, key: string, { min = 100, max = 100_000_000 } = {}): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) invalid("Enter an amount.", key);
  if (!Number.isSafeInteger(value)) invalid("Use at most two decimal places.", key);
  if (value < min) invalid(`The amount must be at least ${money(min)}.`, key);
  if (value > max) invalid(`The amount can be at most ${money(max)}.`, key);
  return value;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * An EVM address. All-lowercase or all-uppercase input carries no checksum
 * and is accepted; mixed case is a checksum, and it must be right: a typo in a
 * money destination should fail loudly, not be silently re-checksummed.
 */
export function address(value: unknown, label = "address", field = "address"): Address {
  if (typeof value !== "string" || !HEX_ADDRESS.test(value.trim())) {
    invalid(`Enter a valid ${label}: 0x followed by 40 letters and numbers.`, field);
  }
  const raw = value.trim();
  const body = raw.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && !isAddress(raw, { strict: true })) {
    invalid("Check the address: its capitalisation doesn't match its checksum.", field);
  }
  const checksummed = getAddress(raw.toLowerCase());
  if (checksummed === zeroAddress) invalid("The zero address can't receive money.", field);
  return checksummed;
}

const MODES: readonly PayMode[] = ["now", "later", "subscribe"];
const USAGES: readonly LinkUsage[] = ["single", "reusable"];
/** A link can live up to a year; null means it never expires. */
const MAX_EXPIRY_HOURS = 24 * 365;

export function parseBusinessName(body: Record<string, unknown>): { businessName: string } {
  return { businessName: text(body, "businessName", { min: 2, max: 80, name: "your business name" }) };
}

export function parseCreateLink(body: Record<string, unknown>): CreateLinkInput {
  const amountCents = cents(body, "amountCents");
  const description = text(body, "description", { max: 120, name: "what the buyer is paying for" });

  const rawModes = body.modes;
  if (!Array.isArray(rawModes) || rawModes.length === 0) invalid("Choose at least one way to pay.", "modes");
  const modes = [...new Set(rawModes)] as PayMode[];
  if (!modes.every((m) => MODES.includes(m))) invalid("Choose Pay now, Pay in 4 or Subscribe.", "modes");
  // Pay in 4 has a floor: below $20 the instalments round to nothing useful.
  if (modes.includes("later") && amountCents < 20_00) invalid(`Pay in 4 needs an amount of at least ${money(20_00)}.`, "modes");

  const usage = body.usage as LinkUsage;
  if (!USAGES.includes(usage)) invalid("Choose single use or reusable.", "usage");
  // A subscription charges again every month: a link that closes after one
  // payment can't carry it (it would silently become a one-time Pay now).
  if (usage === "single" && modes.includes("subscribe")) invalid("Subscriptions need a reusable link.", "usage");

  const expires = body.expiresInHours;
  let expiresInHours: number | null = null;
  if (expires !== null && expires !== undefined) {
    if (typeof expires !== "number" || !Number.isInteger(expires) || expires < 1 || expires > MAX_EXPIRY_HOURS) {
      invalid("Choose an expiry between one hour and one year, or no expiry.", "expiresInHours");
    }
    expiresInHours = expires;
  }

  return { amountCents, description, modes: MODES.filter((m) => modes.includes(m)), usage, expiresInHours };
}

export function parseUpdateLink(body: Record<string, unknown>): UpdateLinkInput {
  if (body.active !== false) invalid("A link can only be turned off.", "active");
  return { active: false };
}

export function parseWithdraw(body: Record<string, unknown>): WithdrawInput {
  const amountCents = cents(body, "amountCents", { min: 1 });
  const destination = address(body.destination, "destination address", "destination");

  const auth = body.authorization;
  if (auth === undefined || auth === null) return { amountCents, destination };
  if (typeof auth !== "object" || Array.isArray(auth)) invalid("The confirmation is malformed. Try again.", "authorization");
  const a = auth as Record<string, unknown>;
  const uint = (k: string) => {
    const v = a[k];
    if (typeof v !== "string" || !/^\d{1,20}$/.test(v)) invalid("The confirmation is malformed. Try again.", "authorization");
    return v;
  };
  const hex = (k: string, bytes?: number) => {
    const v = a[k];
    const pattern = bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]+$/;
    if (typeof v !== "string" || !pattern.test(v)) invalid("The confirmation is malformed. Try again.", "authorization");
    return v as `0x${string}`;
  };
  return {
    amountCents,
    destination,
    authorization: {
      validAfter: uint("validAfter"),
      validBefore: uint("validBefore"),
      nonce: hex("nonce", 32),
      signature: hex("signature"),
    },
  };
}

export function parseAutoPayouts(body: Record<string, unknown>): AutoPayoutsInput {
  if (typeof body.enabled !== "boolean") invalid("Choose on or off.", "enabled");
  const payoutAddress =
    body.payoutAddress === null || body.payoutAddress === undefined || body.payoutAddress === ""
      ? null
      : address(body.payoutAddress, "payout address", "payoutAddress");
  if (body.enabled && !payoutAddress) invalid("Add a payout address before turning on automatic payouts.", "payoutAddress");
  return { enabled: body.enabled, payoutAddress };
}

export function parseCreateApiKey(body: Record<string, unknown>): CreateApiKeyInput {
  return { name: text(body, "name", { max: 60, name: "a name for the key" }) };
}

/**
 * The endpoint's URL, parsed. Whether it may be delivered to (https, a public
 * address) is checked by `assertDeliverableUrl` when it is stored and again,
 * after DNS, at every delivery (`@polaris/db`).
 */
function webhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid("Enter the full endpoint URL, starting with https://.", "url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") invalid("Webhook endpoints must use https://.", "url");
  if (url.username || url.password) invalid("Put credentials in your receiver, not in the URL.", "url");
  return url.toString();
}

function webhookEvents(raw: unknown): WebhookEventType[] {
  if (!Array.isArray(raw) || raw.length === 0) invalid("Choose at least one event.", "events");
  const events = [...new Set(raw)] as WebhookEventType[];
  if (!events.every((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e))) invalid("One of those events isn't one we send.", "events");
  return WEBHOOK_EVENTS.filter((e) => events.includes(e));
}

export function parseCreateWebhook(body: Record<string, unknown>): CreateWebhookInput {
  const url = webhookUrl(text(body, "url", { max: 500, name: "the endpoint URL" }));
  return { url, events: webhookEvents(body.events) };
}
