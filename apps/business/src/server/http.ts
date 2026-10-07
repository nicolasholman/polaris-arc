import "server-only";

import { randomBytes } from "node:crypto";

/**
 * One response shape for every route: `{ data }` on success, `{ error: {
 * code, message, param? } }` on failure. The message is written for the
 * person who will read it (a merchant in the dashboard, a buyer in the
 * checkout, a developer reading an SDK error); the code is for clients to
 * branch on; `param` names the offending field.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param: string | undefined;
  readonly headers: Record<string, string> | undefined;
  constructor(status: number, code: string, message: string, options: { param?: string; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.param = options.param;
    this.headers = options.headers;
  }
}

export function ok<T>(data: T, status = 200, headers?: HeadersInit): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function fail(status: number, code: string, message: string, headers?: HeadersInit, param?: string): Response {
  return Response.json(
    { error: param ? { code, message, param } : { code, message } },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

export function failFrom(error: HttpError): Response {
  return fail(error.status, error.code, error.message, error.headers, error.param);
}

/**
 * A handler for a method the route doesn't support: a JSON 405 with `Allow`,
 * instead of Next's empty body. Export it through the route's wrapper like
 * any other handler.
 */
export function methodNotAllowed(allowed: readonly string[]) {
  return async function notAllowed(): Promise<Response> {
    return fail(405, "method_not_allowed", `This endpoint accepts ${allowed.join(" and ")} only.`, {
      Allow: allowed.join(", "),
    });
  };
}

/** `req_…`: returned as `Polaris-Request-Id` on every response, and logged with every error. */
export function newRequestId(): string {
  return `req_${randomBytes(12).toString("base64url")}`;
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/**
 * The body as text, reading no more than `maxBytes`: a chunked body carries
 * no Content-Length, and `req.text()` would buffer all of it before we could
 * measure it. The stream is cancelled as soon as it runs over.
 */
async function readLimited(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "too_large", "The request body is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The raw body as text, at most `maxBytes` (for bodies whose exact bytes are signed). */
export async function readText(req: Request, { maxBytes = DEFAULT_MAX_BODY_BYTES * 4 } = {}): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "too_large", "The request body is too large.");
  return readLimited(req, maxBytes);
}

/** Parse a JSON object body, refusing anything large, malformed or not an object. */
export async function readJson(req: Request, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send the request body as JSON (Content-Type: application/json).");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "too_large", "The request body is too large.");

  const text = await readLimited(req, maxBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "The request body isn't valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_body", "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/* ── CORS, for the routes a browser on another origin calls ─────────────── */

export type CorsPolicy = { kind: "any" } | { kind: "list"; origins: readonly string[] };

const CORS_ALLOW_HEADERS = "Authorization, Content-Type, Idempotency-Key, Polaris-Client";

/** The CORS headers for this request's Origin, or none when it isn't allowed. */
export function corsHeaders(req: Request, policy: CorsPolicy): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed = policy.kind === "any" ? "*" : policy.origins.includes(origin) ? origin : null;
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": "Polaris-Request-Id, Retry-After",
    "Access-Control-Max-Age": "600",
    ...(policy.kind === "list" ? { Vary: "Origin" } : {}),
  };
}

export function preflight(req: Request, policy: CorsPolicy): Response {
  const headers = corsHeaders(req, policy);
  return new Response(null, { status: headers["Access-Control-Allow-Origin"] ? 204 : 403, headers });
}

/**
 * The caller's IP, for per-IP rate limits, or null when there is none to
 * be had.
 *
 * Route handlers never see the socket, so the address comes from
 * `X-Forwarded-For`, read from the right: every proxy appends the address
 * it received the request from, so the rightmost entries are the ones our
 * own infrastructure wrote and everything left of them is whatever the
 * client sent. With `trustedProxies` proxies in front of us (the platform's
 * edge, a load balancer), the client is the entry that many places from
 * the right; the leftmost entry, which a client controls, is never used.
 *
 * With no proxy (`trustedProxies` 0), Next itself sets `X-Forwarded-For` to
 * the socket's address when the request has none, so the rightmost entry is
 * the socket address. A client talking to Next directly can still send its
 * own header, which is why production runs behind a proxy and says how many
 * (`POLARIS_TRUSTED_PROXIES`; env.ts flags it when unset).
 */
export function clientIp(req: Request, trustedProxies: number): string | null {
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length === 0) {
    const real = trustedProxies > 0 ? req.headers.get("x-real-ip")?.trim() : undefined;
    return real || null;
  }
  return hops[Math.max(0, hops.length - Math.max(1, trustedProxies))] ?? null;
}
