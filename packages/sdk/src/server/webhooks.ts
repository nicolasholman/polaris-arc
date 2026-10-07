import { PolarisSignatureVerificationError, configurationError } from "../errors.js";
import type { WebhookEvent } from "../events.js";
import { hmacSha256Hex, hmacSha256HexAsync, timingSafeEqualHex } from "./hmac.js";

/**
 * Webhook signatures, Stripe-style.
 *
 *   Polaris-Signature: t=1790426298,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
 *
 * v1 is hex(HMAC-SHA256(secret, `${t}.${rawBody}`)), where `secret` is the
 * endpoint's whole signing secret ("whsec_…") as UTF-8 and `rawBody` is the
 * exact bytes delivered. Signing the timestamp with the body is what stops a
 * captured delivery being replayed later: outside the tolerance window (5
 * minutes, either way) it's refused. While a secret is being rotated a header
 * may carry several v1 values; any one matching is enough.
 */

export const WEBHOOK_SIGNATURE_HEADER = "polaris-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type RawBody = string | Uint8Array;
export type SignatureHeader = string | readonly string[] | null | undefined;

export type VerifyOptions = {
  /** Seconds either side of now a signature is accepted. Default 300. 0 disables the check (tests only). */
  toleranceSeconds?: number;
  /** Override "now", in unix seconds (tests). */
  now?: number;
};

const decoder = new TextDecoder();

function bodyText(rawBody: RawBody): string {
  if (typeof rawBody === "string") return rawBody;
  if (rawBody instanceof Uint8Array) return decoder.decode(rawBody);
  throw new PolarisSignatureVerificationError(
    "invalid_payload",
    "Pass the raw request body (string or Buffer) to verify, not a parsed object: re-serialising JSON changes the bytes that were signed.",
  );
}

type ParsedHeader = { timestamp: number; signatures: string[] };

function parseHeader(header: SignatureHeader): ParsedHeader {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolarisSignatureVerificationError("missing_header", "No Polaris-Signature header on the request.");
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(val)) timestamp = Number(val);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(val)) signatures.push(val.toLowerCase());
  }
  if (timestamp === null) {
    throw new PolarisSignatureVerificationError("malformed_header", "The Polaris-Signature header has no valid timestamp (t=…).");
  }
  if (signatures.length === 0) {
    throw new PolarisSignatureVerificationError("no_signatures", "The Polaris-Signature header has no v1 signature.");
  }
  return { timestamp, signatures };
}

function checkTolerance(timestamp: number, options: VerifyOptions): void {
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (tolerance <= 0) return;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new PolarisSignatureVerificationError(
      "timestamp_outside_tolerance",
      `The signature's timestamp is ${Math.abs(now - timestamp)}s from now, outside the ${tolerance}s tolerance. Check your server clock, or this may be a replay.`,
    );
  }
}

function requireSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret === "") {
    throw new PolarisSignatureVerificationError("missing_secret", "Pass the endpoint's signing secret (whsec_…) to verify.");
  }
  return secret;
}

/**
 * Parse a verified body into an event. Deliveries from the first dashboard
 * build used `eventId` / `event` for `id` / `type`; those are normalised.
 */
function parseEvent(text: string): WebhookEvent {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PolarisSignatureVerificationError("invalid_payload", "The signed body isn't JSON.");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new PolarisSignatureVerificationError("invalid_payload", "The signed body isn't a JSON object.");
  }
  const raw = json as Record<string, unknown>;
  const id = raw.id ?? raw.eventId;
  const type = raw.type ?? raw.event;
  if (typeof id !== "string" || typeof type !== "string") {
    throw new PolarisSignatureVerificationError("invalid_payload", "The event has no id or type.");
  }
  const { eventId: _eventId, event: _event, test: _test, ...rest } = raw;
  return {
    ...rest,
    id,
    object: "event",
    type,
    // Test-mode deliveries (and the dashboard's test button) are never live.
    livemode: raw.livemode === true,
    data: raw.data ?? {},
  } as unknown as WebhookEvent;
}

/**
 * Verify a webhook and return its event. Throws
 * `PolarisSignatureVerificationError` (with a `reason`) when the header is
 * missing or malformed, the timestamp is outside the tolerance, or no v1
 * signature matches. Respond 400 to those and don't process the body.
 */
export function verifyWebhook(rawBody: RawBody, signatureHeader: SignatureHeader, secret: string, options: VerifyOptions = {}): WebhookEvent {
  const key = requireSecret(secret);
  const text = bodyText(rawBody);
  const { timestamp, signatures } = parseHeader(signatureHeader);
  const expected = hmacSha256Hex(key, `${timestamp}.${text}`);
  // Compare every candidate, so timing doesn't reveal which one matched.
  let matched = false;
  for (const candidate of signatures) matched = timingSafeEqualHex(expected, candidate) || matched;
  if (!matched) {
    throw new PolarisSignatureVerificationError(
      "signature_mismatch",
      "No signature matches. Check you're using this endpoint's signing secret and the raw request body.",
    );
  }
  checkTolerance(timestamp, options);
  return parseEvent(text);
}

/** `verifyWebhook` through Web Crypto, for edge runtimes that prefer it. */
export async function verifyWebhookAsync(
  rawBody: RawBody,
  signatureHeader: SignatureHeader,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  const key = requireSecret(secret);
  const text = bodyText(rawBody);
  const { timestamp, signatures } = parseHeader(signatureHeader);
  const expected = await hmacSha256HexAsync(key, `${timestamp}.${text}`);
  let matched = false;
  for (const candidate of signatures) matched = timingSafeEqualHex(expected, candidate) || matched;
  if (!matched) {
    throw new PolarisSignatureVerificationError(
      "signature_mismatch",
      "No signature matches. Check you're using this endpoint's signing secret and the raw request body.",
    );
  }
  checkTolerance(timestamp, options);
  return parseEvent(text);
}

/** The signature header for `payload`: what Polaris sends. Use it to test your handler. */
export function signWebhookPayload(payload: string, secret: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  if (!Number.isInteger(timestamp) || timestamp < 0) throw configurationError("invalid_timestamp", "timestamp must be unix seconds.");
  return `t=${timestamp},v1=${hmacSha256Hex(requireSecret(secret), `${timestamp}.${payload}`)}`;
}

/** Stripe's name for the same thing: a header for a test payload. */
export function generateTestHeader(args: { payload: string; secret: string; timestamp?: number }): string {
  return signWebhookPayload(args.payload, args.secret, args.timestamp);
}
