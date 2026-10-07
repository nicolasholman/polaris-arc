/**
 * The underwriting HTTP API, for the app and the gateway.
 *
 *   GET  /health                  each provider live or not_configured, and versions
 *   POST /v1/underwrite           evidence → Facts, report, score, decision, reasons
 *   POST /v1/explain              Facts, or an UnderwritingReceiver report → score, decision, reasons
 *   GET  /v1/link-message         the exact text a linked wallet signs
 *
 * Two adapters over one router: `createNodeHandler` for `node:http` (the
 * gateway) and `handleFetch` for Fetch `Request`/`Response` (a Next.js route
 * handler). Bigints travel as decimal strings; amounts are 6-decimal base
 * units unless a field says dollars.
 *
 * `/v1/underwrite` spends Nansen credits, so it is not open: set
 * `UNDERWRITING_API_TOKEN` and send `Authorization: Bearer <token>` from the
 * app's server. CORS is an explicit allowlist, never `*` (plan §4).
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeUnderwritingReport, validateFacts } from "../core/abi.ts";
import { toJsonSafe } from "../core/evidence.ts";
import { parseDollars } from "../core/format.ts";
import { linkMessage } from "../core/link.ts";
import type { Address, Facts, Hex } from "../core/types.ts";
import { explainOnChainFacts } from "../core/underwrite.ts";
import { SERVICE_VERSION, type Underwriter } from "./service.ts";

export interface HandlerOptions {
  /**
   * Required bearer token for /v1/*. Unset: no auth, for loopback only;
   * `startUnderwritingServer` refuses any other host without one. A Fetch
   * handler mounted in a deployed app has no such check: give it a token.
   */
  token?: string;
  /** Origins allowed to call from a browser. */
  corsOrigins?: string[];
  /** Requests per minute per client on /v1/underwrite. Default 30. */
  rateLimitPerMinute?: number;
  /** Milliseconds, for the rate limiter. */
  now?: () => number;
}

export interface RouteRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
  /** Who is calling, for the rate limit. */
  client: string;
}

export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const MAX_BODY = 16 * 1024;

class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isAddr = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

function json(status: number, value: unknown, extra: Record<string, string> = {}): RouteResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
    body: JSON.stringify(toJsonSafe(value)),
  };
}

function bigintField(v: unknown, name: string): bigint | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,30}$/.test(v)) return BigInt(v);
  throw new HttpProblem(400, "invalid_field", `${name} must be a non-negative integer in base units`);
}

function dollarsField(v: unknown, name: string): bigint | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  try {
    return parseDollars(String(v));
  } catch {
    throw new HttpProblem(400, "invalid_field", `${name} must be a dollar amount like "200.00"`);
  }
}

function parseBody(req: RouteRequest): Record<string, unknown> {
  if (req.body.length > MAX_BODY) throw new HttpProblem(413, "too_large", "request body is too large");
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new HttpProblem(415, "unsupported_media_type", "send application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body || "{}");
  } catch {
    throw new HttpProblem(400, "invalid_json", "body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpProblem(400, "invalid_json", "body must be an object");
  return parsed as Record<string, unknown>;
}

function factsFrom(v: unknown): Facts {
  if (!v || typeof v !== "object") throw new HttpProblem(400, "invalid_field", "facts must be an object");
  const f = v as Record<string, unknown>;
  const int = (name: string) => {
    const x = f[name];
    if (typeof x === "number" && Number.isSafeInteger(x)) return x;
    if (typeof x === "string" && /^\d+$/.test(x) && Number.isSafeInteger(Number(x))) return Number(x);
    throw new HttpProblem(400, "invalid_field", `facts.${name} must be an integer`);
  };
  const facts: Facts = {
    walletAgeDays: int("walletAgeDays"),
    txCount: int("txCount"),
    stableBalance: bigintField(f.stableBalance, "facts.stableBalance") ?? 0n,
    defiTenureDays: int("defiTenureDays"),
    priorLiquidations: int("priorLiquidations"),
    relatedWallets: int("relatedWallets"),
    exchangeFunded: f.exchangeFunded === true,
    observedAt: bigintField(f.observedAt, "facts.observedAt") ?? 0n,
  };
  try {
    validateFacts(facts);
  } catch (err) {
    throw new HttpProblem(400, "invalid_field", (err as Error).message);
  }
  return facts;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createRouter(underwriter: Underwriter, opts: HandlerOptions = {}) {
  const limit = opts.rateLimitPerMinute ?? 30;
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  const allowed = new Set(opts.corsOrigins ?? []);

  function cors(req: RouteRequest): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  }

  function rateLimited(client: string): boolean {
    const t = now();
    const w = windows.get(client);
    if (!w || t - w.start >= 60_000) {
      windows.set(client, { start: t, count: 1 });
      if (windows.size > 10_000) windows.clear();
      return false;
    }
    w.count += 1;
    return w.count > limit;
  }

  return async function route(req: RouteRequest): Promise<RouteResponse> {
    const url = new URL(req.url, "http://localhost");
    const c = cors(req);
    try {
      if (req.method === "OPTIONS") return { status: 204, headers: c, body: "" };

      if (url.pathname === "/health") {
        if (req.method !== "GET") throw new HttpProblem(405, "method_not_allowed", "use GET");
        return json(
          200,
          { ok: true, service: "polaris-underwriting", version: SERVICE_VERSION, modes: underwriter.modes(), notConfigured: underwriter.notConfigured() },
          c,
        );
      }

      if (!url.pathname.startsWith("/v1/")) throw new HttpProblem(404, "not_found", "no such route");
      if (opts.token) {
        const auth = req.headers.authorization ?? "";
        const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!given || !safeEqual(given, opts.token)) throw new HttpProblem(401, "unauthorized", "missing or wrong bearer token");
      }

      if (url.pathname === "/v1/link-message") {
        if (req.method !== "GET") throw new HttpProblem(405, "method_not_allowed", "use GET");
        const account = url.searchParams.get("account");
        const wallet = url.searchParams.get("wallet");
        const issuedAt = Number(url.searchParams.get("issuedAt"));
        const nonce = url.searchParams.get("nonce") ?? "";
        if (!isAddr(account) || !isAddr(wallet)) throw new HttpProblem(400, "invalid_field", "account and wallet must be addresses");
        if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new HttpProblem(400, "invalid_field", "issuedAt must be unix seconds");
        try {
          return json(200, { message: linkMessage({ account, wallet, issuedAt, nonce }) }, c);
        } catch (err) {
          throw new HttpProblem(400, "invalid_field", (err as Error).message);
        }
      }

      if (url.pathname === "/v1/underwrite") {
        if (req.method !== "POST") throw new HttpProblem(405, "method_not_allowed", "use POST");
        if (rateLimited(req.client)) throw new HttpProblem(429, "rate_limited", "too many underwriting requests; try again in a minute");
        const body = parseBody(req);
        if (!isAddr(body.account)) throw new HttpProblem(400, "invalid_field", "account must be an address");
        let linked: { wallet: Address; proof: { issuedAt: number; nonce: string; signature: Hex } | null } | null = null;
        if (body.linked !== undefined && body.linked !== null) {
          const l = body.linked as Record<string, unknown>;
          if (!isAddr(l.wallet)) throw new HttpProblem(400, "invalid_field", "linked.wallet must be an address");
          let proof = null;
          if (l.proof) {
            const p = l.proof as Record<string, unknown>;
            if (typeof p.issuedAt !== "number" || typeof p.nonce !== "string" || typeof p.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(p.signature)) {
              throw new HttpProblem(400, "invalid_field", "linked.proof needs issuedAt (unix seconds), nonce and signature (hex)");
            }
            proof = { issuedAt: p.issuedAt, nonce: p.nonce, signature: p.signature as Hex };
          }
          linked = { wallet: l.wallet, proof };
        }
        const assessment = await underwriter.assess({
          account: body.account,
          linked,
          purchase: dollarsField(body.purchase, "purchase") ?? bigintField(body.purchaseBaseUnits, "purchaseBaseUnits") ?? null,
          activeDebt: bigintField(body.activeDebt, "activeDebt"),
          allowPartial: body.allowPartial === true,
        });
        // The derivation duplicates the facts and evidence; send what the app reads.
        const { derivation, ...rest } = assessment;
        return json(200, { ...rest, attribution: derivation.attribution, linked: derivation.linked }, c);
      }

      if (url.pathname === "/v1/explain") {
        if (req.method !== "POST") throw new HttpProblem(405, "method_not_allowed", "use POST");
        const body = parseBody(req);
        const activeDebt = bigintField(body.activeDebt, "activeDebt");
        const purchase = dollarsField(body.purchase, "purchase") ?? bigintField(body.purchaseBaseUnits, "purchaseBaseUnits") ?? null;
        if (body.report !== undefined) {
          // The report body UnderwritingReceiver.onReport received (after the
          // forwarder's metadata): abi.encode(uint8 2, (user, linkedWallet, Facts)[]).
          if (typeof body.report !== "string") throw new HttpProblem(400, "invalid_field", "report must be a 0x hex string");
          let decoded: ReturnType<typeof decodeUnderwritingReport>;
          try {
            decoded = decodeUnderwritingReport(body.report as Hex);
          } catch (err) {
            throw new HttpProblem(400, "invalid_field", `report: ${(err as Error).message}`);
          }
          const items = decoded.items.map((item) => ({
            user: item.user,
            linkedWallet: item.linkedWallet,
            facts: item.facts,
            ...explainOnChainFacts(item.facts, { activeDebt, purchase, hasLinked: item.linkedWallet !== null || body.hasLinked === true }),
          }));
          // The workflow sends one underwriting per report; spread it for the common case.
          return json(200, { kind: decoded.kind, items, ...(items.length === 1 ? items[0] : {}) }, c);
        }
        const facts: Facts = factsFrom(body.facts);
        const out = explainOnChainFacts(facts, { activeDebt, purchase, hasLinked: body.hasLinked === true });
        return json(200, { user: null, linkedWallet: null, facts, ...out }, c);
      }

      throw new HttpProblem(404, "not_found", "no such route");
    } catch (err) {
      if (err instanceof HttpProblem) return json(err.status, { error: { code: err.code, message: err.message } }, c);
      return json(500, { error: { code: "internal", message: "underwriting failed" } }, c);
    }
  };
}

/** A `node:http` request listener. */
export function createNodeHandler(underwriter: Underwriter, opts: HandlerOptions = {}) {
  const route = createRouter(underwriter, opts);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk as Buffer);
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    const out = tooLarge
      ? { status: 413, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "too_large", message: "request body is too large" } }) }
      : await route({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
          client: req.socket.remoteAddress ?? "unknown",
        });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  };
}

/** A Fetch handler, e.g. `export const POST = (r: Request) => handleFetch(uw, r)` in a Next.js route. */
export function createFetchHandler(underwriter: Underwriter, opts: HandlerOptions = {}) {
  const route = createRouter(underwriter, opts);
  return async (request: Request, client = "fetch"): Promise<Response> => {
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const out = await route({ method: request.method, url: request.url, headers, body, client });
    return new Response(out.status === 204 ? null : out.body, { status: out.status, headers: out.headers });
  };
}
