/**
 * Merchant webhooks: signing, the event envelope, the retry schedule, and one
 * delivery attempt with an SSRF guard.
 *
 * The scheme is exactly what polarispay-sdk verifies (packages/sdk, "HTTP
 * API" → "Webhook deliveries"):
 *
 *   POST <endpoint>
 *   Content-Type: application/json
 *   Polaris-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 *   Polaris-Event: <type>
 *   Polaris-Delivery-Attempt: <n>
 *
 *   {"id":"evt_…","object":"event","type":"…","createdAt":"…","livemode":false,"merchantId":"mer_…","data":{…}}
 *
 * The secret is the endpoint's whole `whsec_…` string as UTF-8. Signing
 * `t.body` rather than the body alone is what lets a receiver refuse a
 * captured request replayed later (the SDK's tolerance is 300 s).
 *
 * Delivery is at least once. The body of an event is built once and stored,
 * so every retry sends the same bytes under a fresh timestamp.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const WEBHOOK_SIGNATURE_HEADER = "polaris-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The nine events, exactly as plan §5.8 and the SDK list them. */
export const WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "plan.opened",
  "installment.collected",
  "installment.failed",
  "plan.completed",
  "plan.liquidated",
  "subscription.charged",
  "subscription.canceled",
  "payout.paid",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(value);
}

export type WebhookEnvelope = {
  id: string;
  object: "event";
  type: WebhookEventType;
  createdAt: string;
  livemode: boolean;
  merchantId: string;
  data: Record<string, unknown>;
};

/** The exact JSON body a delivery carries. Key order is fixed. */
export function serializeEvent(event: WebhookEnvelope): string {
  return JSON.stringify({
    id: event.id,
    object: "event",
    type: event.type,
    createdAt: event.createdAt,
    livemode: event.livemode,
    merchantId: event.merchantId,
    data: event.data,
  });
}

/* ── Signatures ─────────────────────────────────────────────────────────── */

export function signatureFor(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/** `t=<unix>,v1=<hex>`. */
export function signWebhookBody(secret: string, body: string, timestamp: number): string {
  if (!secret) throw new Error("A webhook secret is required to sign a delivery.");
  return `t=${timestamp},v1=${signatureFor(secret, body, timestamp)}`;
}

export type VerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing_header" | "malformed_header" | "no_signatures" | "timestamp_outside_tolerance" | "signature_mismatch" };

/**
 * Verify a `Polaris-Signature` header. Receivers should use the SDK's
 * `webhooks.verify`; this is the same check, for our own tests and tools.
 * Several `v1=` values are allowed (secret rotation); one match is enough.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  { nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "missing_header" };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null) return { ok: false, reason: "malformed_header" };
  if (signatures.length === 0) return { ok: false, reason: "no_signatures" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "timestamp_outside_tolerance" };
  const expected = Buffer.from(signatureFor(secret, body, timestamp), "hex");
  const matched = signatures.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matched ? { ok: true, timestamp } : { ok: false, reason: "signature_mismatch" };
}

/* ── Retries ────────────────────────────────────────────────────────────── */

/**
 * Seconds to wait after the nth failed attempt (1-based) before the next.
 * Eight attempts over about 34 hours, Stripe's shape: quick retries for a
 * blip, then backing off for an outage.
 */
export const RETRY_SCHEDULE_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 10 * 3600, 15 * 3600] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;

/**
 * When to try again after `attemptsMade` failed attempts, or null when the
 * schedule is exhausted. `jitter` (0..1) spreads retries by up to 10% so a
 * recovering endpoint isn't hit by every queued event in the same second.
 */
export function nextAttemptAt(attemptsMade: number, nowMs: number, jitter = Math.random()): number | null {
  const delay = RETRY_SCHEDULE_SECONDS[attemptsMade - 1];
  if (delay === undefined) return null;
  return nowMs + Math.round(delay * 1000 * (1 + 0.1 * Math.min(Math.max(jitter, 0), 1)));
}

/* ── SSRF guard ─────────────────────────────────────────────────────────── */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

/** True for loopback, private, link-local, reserved and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith("64:ff9b:")) return true; // NAT64 can reach private v4
    if (lower.startsWith("2001:db8:")) return true; // documentation
    return false;
  }
  return true; // not an IP at all: refuse
}

/**
 * Link-local addresses (169.254.0.0/16, fe80::/10) hold cloud metadata
 * services. Refused even in development, where other private addresses are
 * allowed for a local receiver.
 */
export function isLinkLocal(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ip.startsWith("169.254.");
  if (family === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isLinkLocal(mapped[1]);
    return (Number.parseInt(lower.split(":")[0] || "0", 16) & 0xffc0) === 0xfe80;
  }
  return false;
}

export class WebhookUrlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlRefused";
  }
}

/** Check an endpoint URL before storing it. DNS is checked again at delivery. */
export function assertDeliverableUrl(raw: string, { allowPrivate = false } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlRefused("Enter the full endpoint URL, starting with https://.");
  }
  if (url.username || url.password) throw new WebhookUrlRefused("Put credentials in your receiver, not in the URL.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isLinkLocal(host)) throw new WebhookUrlRefused("Webhook endpoints must be reachable on the public internet.");
  const local = host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && isPrivateAddress(host));
  if (url.protocol === "http:") {
    if (!(allowPrivate && local)) throw new WebhookUrlRefused("Webhook endpoints must use https://.");
  } else if (url.protocol !== "https:") {
    throw new WebhookUrlRefused("Webhook endpoints must use https://.");
  }
  if (local && !allowPrivate) throw new WebhookUrlRefused("Webhook endpoints must be reachable on the public internet.");
  return url;
}

/* ── One delivery attempt ───────────────────────────────────────────────── */

export type DeliveryRequest = {
  url: string;
  secret: string;
  eventType: WebhookEventType;
  /** From `serializeEvent`. */
  body: string;
  /** 1-based. */
  attempt: number;
  timeoutMs?: number;
  /** Development only: allow localhost and private addresses. */
  allowPrivate?: boolean;
  nowSeconds?: number;
  /** Replaces the network, for tests. */
  transport?: Transport;
};

export type DeliveryOutcome = {
  ok: boolean;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  durationMs: number;
  /** Why it failed, written for the delivery log. */
  error: string | null;
  /** The start of the response body, for the delivery log. */
  responseBody: string | null;
  /** Whether trying again could help (false for a URL the guard refuses). */
  retryable: boolean;
  /** Exactly what was sent. */
  request: { headers: Record<string, string>; body: string };
};

export type TransportResponse = { status: number; body: string };
export type Transport = (
  url: URL,
  init: { headers: Record<string, string>; body: string; timeoutMs: number; allowPrivate: boolean },
) => Promise<TransportResponse>;

const MAX_RESPONSE_BYTES = 2048;

/**
 * POST with node:http(s), resolving the host ourselves and refusing any
 * private address at connect time (not just when the URL was saved), which
 * also defeats DNS rebinding. Redirects are not followed.
 *
 * `timeoutMs` bounds the whole attempt, from DNS to the last byte: Node's own
 * `timeout` is only a socket idle timer, which an endpoint trickling a byte
 * at a time never trips. And the body is read only up to MAX_RESPONSE_BYTES;
 * past that the response is dropped, so one slow or chatty merchant endpoint
 * can't hold a delivery (and the dispatcher's pass) for longer than that.
 */
export const nodeTransport: Transport = (url, init) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const lookup = (
      hostname: string,
      options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ) => {
      dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err, [], 0);
        const list = addresses as LookupAddress[];
        const bad = list.find((a) => isLinkLocal(a.address) || (isPrivateAddress(a.address) && !init.allowPrivate));
        if (bad) {
          return callback(Object.assign(new Error(`refused: ${hostname} resolves to a private address`), { code: "EPRIVATE" }), [], 0);
        }
        const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
        if (wantsAll) return callback(null, list);
        const first = list[0];
        if (!first) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), [], 0);
        return callback(null, first.address, first.family);
      });
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "POST",
        headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
        lookup: lookup as never,
        timeout: init.timeoutMs,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () =>
          finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_RESPONSE_BYTES) }));
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_RESPONSE_BYTES) {
            // All we keep is in: answer now and stop reading.
            done();
            req.destroy();
          }
        });
        res.on("end", done);
        res.on("error", (error) => finish(() => reject(error)));
      },
    );
    deadline = setTimeout(() => {
      const error = Object.assign(new Error(`no complete response within ${init.timeoutMs} ms`), { code: "ETIMEDOUT" });
      finish(() => reject(error));
      req.destroy(error);
    }, init.timeoutMs);
    req.on("timeout", () => req.destroy(Object.assign(new Error(`no response within ${init.timeoutMs} ms`), { code: "ETIMEDOUT" })));
    req.on("error", (error) => finish(() => reject(error)));
    req.end(init.body);
  });

/** Sign and send one attempt. Never throws; the outcome says what happened. */
export async function deliverWebhook(req: DeliveryRequest): Promise<DeliveryOutcome> {
  const timestamp = req.nowSeconds ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Polaris-Webhooks/1.0 (+https://polarispay.app)",
    "polaris-signature": signWebhookBody(req.secret, req.body, timestamp),
    "polaris-event": req.eventType,
    "polaris-delivery-attempt": String(req.attempt),
  };
  const request = { headers, body: req.body };
  const started = Date.now();
  let url: URL;
  try {
    url = assertDeliverableUrl(req.url, { allowPrivate: req.allowPrivate });
  } catch (error) {
    return { ok: false, status: null, durationMs: 0, error: (error as Error).message, responseBody: null, retryable: false, request };
  }
  try {
    const res = await (req.transport ?? nodeTransport)(url, {
      headers,
      body: req.body,
      timeoutMs: req.timeoutMs ?? 10_000,
      allowPrivate: Boolean(req.allowPrivate),
    });
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      status: res.status,
      durationMs: Date.now() - started,
      error: ok ? null : `The endpoint answered ${res.status}.`,
      responseBody: res.body || null,
      retryable: !ok,
      request,
    };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    const refused = e.code === "EPRIVATE";
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      error: refused ? "Refused: the endpoint resolves to a private address." : `Couldn't reach the endpoint (${e.code ?? e.message}).`,
      responseBody: null,
      retryable: !refused,
      request,
    };
  }
}
