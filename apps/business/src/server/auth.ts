import "server-only";

import { timingSafeEqual } from "node:crypto";

import { hashSecretKey, parseApiKey, type ApiKeyRecord, type MerchantRecord } from "@polaris/db";
import { getAddress, isAddress } from "viem";

import type { Address } from "@/lib/data/types";
import { ChainNotConfigured } from "./chain/client";
import { getDb } from "./db";
import { getConfig } from "./env";
import { verifyCreSignature } from "./credit/callback-signature";
import { clientIp, corsHeaders, failFrom, fail, HttpError, newRequestId, preflight, readText, type CorsPolicy } from "./http";
import { PolicyViolation } from "./policy/relayer";
import { getPrivy } from "./privy";
import { consume, LIMITS, type Limit } from "./ratelimit";
import { RelayRejected, RelayUnavailable } from "./relayer/submit";

/**
 * Who is calling, proven server-side. Every route handler under `app/api` is
 * exported through exactly one of these wrappers, and `pnpm lint` fails if
 * one isn't (scripts/check-api-auth.mjs):
 *
 * | Wrapper              | Credential                                   | Used by                          |
 * |----------------------|----------------------------------------------|----------------------------------|
 * | `withMerchant`       | Privy access token (Bearer or `privy-token`) | the dashboard                    |
 * | `withSecretKey`      | `sk_test_…` API key                          | merchants' servers (the SDK)     |
 * | `withPublishableKey` | `pk_test_…` API key                          | merchants' pages (SDK direct pay)|
 * | `withSignedRequest`  | the payer's own EIP-712 / ERC-3009 signature | the Polaris app's relay calls    |
 * |                      | or EIP-191 (credit consent, receipts)        | and its credit and receipts calls|
 * | `withPublic`         | none: public data only, rate-limited         | the hosted checkout's reads      |
 * | `withCron`           | `CRON_SECRET`                                | schedulers                       |
 *
 * The old merchant platform read the merchant's wallet from an
 * `x-wallet-address` header. Here nothing a client sends can name the
 * merchant: it comes from the verified token or the hashed key.
 */

export type AuthedMerchant = {
  /** The Privy user ID (`did:privy:...`). */
  userId: string;
  /** The user's Privy embedded wallet. Null in the moment between login and wallet creation. */
  walletAddress: Address | null;
  /** Privy's id for that wallet. */
  walletId: string | null;
  email: string | null;
  sessionId: string;
};

type TokenSource = "header" | "cookie";

const COOKIE_NAME = "privy-token";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function readToken(req: Request): { token: string; source: TokenSource } | null {
  if (req.headers.get("authorization")) {
    const token = bearer(req);
    return token ? { token, source: "header" } : null;
  }
  const cookies = req.headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed cookie ("%", "%E0%A4%A") is no session: 401, never a 500.
      return null;
    }
    return value ? { token: value, source: "cookie" } : null;
  }
  return null;
}

/**
 * A cookie rides along on cross-site requests; a Bearer header can't. When the
 * token came from the cookie, refuse a state-changing request that another
 * site could have forged.
 */
function assertSameOrigin(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site) {
    if (site === "same-origin") return;
    throw new HttpError(403, "cross_site", "This request came from another site and was refused.");
  }
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host === new URL(req.url).host) return;
    } catch {
      // "null" or a malformed origin: fall through and refuse.
    }
  }
  throw new HttpError(403, "cross_site", "This request came from another site and was refused.");
}

/* ── The embedded wallet, looked up from Privy and cached briefly ──────── */

type Profile = { walletAddress: Address | null; walletId: string | null; email: string | null };
const profiles = new Map<string, { value: Profile; expires: number }>();
const PROFILE_TTL_MS = 5 * 60_000;
/** Before the wallet exists, look again soon: it is created right after login. */
const PENDING_TTL_MS = 10_000;
const MAX_CACHED = 5_000;

type LinkedAccount = {
  type?: string;
  id?: string | null;
  address?: string;
  email?: string;
  chain_type?: string;
  connector_type?: string;
  wallet_client_type?: string;
};

export function profileFrom(accounts: readonly LinkedAccount[]): Profile {
  let walletAddress: Address | null = null;
  let walletId: string | null = null;
  let email: string | null = null;
  for (const account of accounts) {
    const embedded =
      account.type === "wallet" &&
      account.chain_type === "ethereum" &&
      (account.connector_type === "embedded" || account.wallet_client_type === "privy");
    if (embedded && !walletAddress && account.address && isAddress(account.address)) {
      walletAddress = getAddress(account.address);
      walletId = account.id ?? null;
    }
    if (!email && account.type === "email" && account.address) email = account.address;
    if (!email && account.type === "google_oauth" && account.email) email = account.email;
  }
  return { walletAddress, walletId, email };
}

async function lookupProfile(userId: string): Promise<Profile> {
  const cached = profiles.get(userId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const privy = getPrivy();
  if (!privy) throw new HttpError(503, "auth_not_configured", "Sign-in isn't configured on this server.");

  let accounts: readonly LinkedAccount[];
  try {
    const user = await privy.users()._get(userId);
    accounts = (user.linked_accounts ?? []) as readonly LinkedAccount[];
  } catch (error) {
    const status = privyStatus(error);
    // A valid token for a user Privy no longer has (deleted): the session is over.
    if (status === 404) throw new HttpError(401, "invalid_token", "Your session has expired. Sign in again.");
    // Privy refused our app secret: a server configuration problem, not the merchant's.
    if (status === 401 || status === 403) {
      console.error("[auth] Privy rejected the app credentials while loading a user", status);
      throw new HttpError(503, "auth_not_configured", "Sign-in isn't configured correctly on this server.");
    }
    throw new HttpError(502, "privy_unavailable", "We couldn't reach Privy to load your account. Try again.");
  }

  const value = profileFrom(accounts);
  if (profiles.size >= MAX_CACHED) profiles.clear();
  profiles.set(userId, { value, expires: Date.now() + (value.walletAddress ? PROFILE_TTL_MS : PENDING_TTL_MS) });
  return value;
}

/** The HTTP status of a failed Privy API call, when it had one. */
function privyStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/* ── Test seam: route tests authenticate without Privy ──────────────────── */

type MerchantVerifier = (req: Request) => Promise<AuthedMerchant>;
let verifierOverride: MerchantVerifier | null = null;

/** Tests only: replace Privy token verification. Refused in production. */
export function setMerchantVerifierForTests(verifier: MerchantVerifier | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("Not in production.");
  verifierOverride = verifier;
}

/**
 * `pnpm demo:local`'s signed-in dashboard: the demo merchant, for the
 * configured random token presented as a Bearer token. `getConfig()` only
 * sets `localSession` outside production, on a local chain, with Privy off,
 * so no deployed server has this door. The merchant record is the one
 * `scripts/lib/seed.mjs` creates (`dev:<wallet>`).
 */
function localSession(req: Request): AuthedMerchant | null {
  const local = getConfig().localSession;
  if (!local) return null;
  const presented = bearer(req);
  if (!presented) return null;
  const a = Buffer.from(presented);
  const b = Buffer.from(local.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId: `dev:${local.wallet.toLowerCase()}`, walletAddress: local.wallet, walletId: null, email: null, sessionId: "local" };
}

/**
 * Verify the request's Privy access token (`Authorization: Bearer` or the
 * `privy-token` cookie) and return the merchant it belongs to. Throws an
 * `HttpError` (401, 403, 502 or 503) otherwise.
 */
export async function authenticate(req: Request): Promise<AuthedMerchant> {
  if (verifierOverride) return verifierOverride(req);
  const local = localSession(req);
  if (local) return local;
  const privy = getPrivy();
  if (!privy) {
    // The local session is a sign-in too: a request without its token is
    // unauthenticated, not a server without sign-in.
    if (getConfig().localSession) throw new HttpError(401, "unauthenticated", "Sign in to continue.");
    throw new HttpError(503, "auth_not_configured", "Sign-in isn't configured on this server.");
  }

  const found = readToken(req);
  if (!found) throw new HttpError(401, "unauthenticated", "Sign in to continue.");
  if (found.source === "cookie" && UNSAFE_METHODS.has(req.method.toUpperCase())) assertSameOrigin(req);

  let userId: string;
  let sessionId: string;
  try {
    // @privy-io/node 0.35: takes the token string, returns snake_case claims.
    const claims = await privy.utils().auth().verifyAccessToken(found.token);
    userId = claims.user_id;
    sessionId = claims.session_id;
  } catch {
    throw new HttpError(401, "invalid_token", "Your session has expired. Sign in again.");
  }
  if (!userId) throw new HttpError(401, "invalid_token", "Your session has expired. Sign in again.");

  const profile = await lookupProfile(userId);
  return { userId, sessionId, ...profile };
}

/* ── API keys ───────────────────────────────────────────────────────────── */

export type KeyContext = { merchant: MerchantRecord; key: ApiKeyRecord };

/** The stored form of a presented secret key; refuses to run unpeppered in production. */
export function hashKey(secret: string): string {
  const { keyPepper, production } = getConfig();
  if (!keyPepper && production) {
    throw new HttpError(503, "not_configured", "API keys aren't configured on this server (POLARIS_KEY_PEPPER).");
  }
  return hashSecretKey(secret, keyPepper);
}

async function touch(key: ApiKeyRecord): Promise<void> {
  const last = key.lastUsedAt ? Date.parse(key.lastUsedAt) : 0;
  if (Date.now() - last < 60_000) return;
  await getDb().apiKeys.update(key.id, (k) => ({ ...k, lastUsedAt: new Date().toISOString() }));
}

const INVALID_KEY = () =>
  new HttpError(401, "invalid_api_key", "Invalid API key. Find yours in Polaris for Business under Developers → API keys.", {
    headers: { "WWW-Authenticate": 'Bearer realm="polaris"' },
  });

export async function authenticateSecretKey(req: Request): Promise<KeyContext> {
  const presented = bearer(req);
  if (!presented) throw INVALID_KEY();
  const parsed = parseApiKey(presented);
  if (!parsed) throw INVALID_KEY();
  if (parsed.kind === "publishable") {
    throw new HttpError(403, "secret_key_required", "This call needs your secret key (sk_test_…). Publishable keys are for the browser.");
  }
  if (parsed.mode === "live") throw new HttpError(401, "invalid_api_key", "Live keys aren't enabled yet: use your sk_test_ key on Monad testnet.");
  const db = getDb();
  const key = await db.apiKeys.findOne({ secretHash: hashKey(presented) });
  if (!key || key.revokedAt) throw INVALID_KEY();
  const merchant = await db.merchants.get(key.merchantId);
  if (!merchant) throw INVALID_KEY();
  consume(LIMITS.apiPerKey, key.id);
  await touch(key);
  return { merchant, key };
}

export async function authenticatePublishableKey(req: Request): Promise<KeyContext> {
  const presented = bearer(req);
  const parsed = presented ? parseApiKey(presented) : null;
  if (!presented || !parsed) throw INVALID_KEY();
  if (parsed.kind === "secret") {
    // A secret key in a browser request is a leak waiting to happen: say so.
    throw new HttpError(403, "publishable_key_required", "Never send a secret key from a browser. Use your publishable key (pk_test_…).");
  }
  const db = getDb();
  const key = await db.apiKeys.findOne({ publishableKey: presented });
  if (!key || key.revokedAt) throw INVALID_KEY();
  const merchant = await db.merchants.get(key.merchantId);
  if (!merchant) throw INVALID_KEY();
  consume(LIMITS.apiPerKey, key.id);
  return { merchant, key };
}

/* ── One error handler for every wrapper ────────────────────────────────── */

function toResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) return failFrom(error);
  if (error instanceof RelayRejected) return fail(error.error.status, error.error.code, error.error.message);
  if (error instanceof RelayUnavailable) {
    console.error(`[api ${requestId}] relay unavailable (${error.code})`, error.cause ?? error);
    return fail(503, error.code, error.message, { "Retry-After": "2" });
  }
  if (error instanceof PolicyViolation) {
    console.error(`[api ${requestId}] relayer policy refused a call: ${error.message}`);
    return fail(403, "policy_violation", "The relayer's policy doesn't allow this.");
  }
  if (error instanceof ChainNotConfigured) return fail(503, "chain_not_configured", "Payments aren't configured on this server yet.");
  console.error(`[api ${requestId}] unhandled error`, error);
  return fail(500, "internal", "Something went wrong on our side. Try again.");
}

type Handler<A, Ctx> = (req: Request, auth: A, ctx: Ctx, meta: { requestId: string }) => Promise<Response>;

function wrap<A, Ctx>(
  authenticateFn: (req: Request) => Promise<A>,
  handler: Handler<A, Ctx>,
  options: { cors?: () => CorsPolicy; limit?: Limit } = {},
) {
  return async function route(req: Request, ctx: Ctx): Promise<Response> {
    const requestId = newRequestId();
    let res: Response;
    try {
      if (options.limit) consume(options.limit, clientKey(req));
      const auth = await authenticateFn(req);
      res = await handler(req, auth, ctx, { requestId });
    } catch (error) {
      res = toResponse(error, requestId);
    }
    res.headers.set("Polaris-Request-Id", requestId);
    if (options.cors) for (const [k, v] of Object.entries(corsHeaders(req, options.cors()))) res.headers.set(k, v);
    if (res.status === 401 && !res.headers.has("WWW-Authenticate")) res.headers.set("WWW-Authenticate", 'Bearer realm="polaris"');
    return res;
  };
}

/**
 * The configuration for the wrapper's own steps (CORS, the rate-limit key),
 * or null while the environment doesn't parse. Those steps then allow no
 * origin and trust no proxy, and the handler's own getConfig() answers with
 * the error (a JSON 500, and /api/health/ready's 503 saying what is wrong)
 * instead of the wrapper crashing after it.
 */
function configOrNull(): ReturnType<typeof getConfig> | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}

const appCors = (): CorsPolicy => ({ kind: "list", origins: configOrNull()?.appOrigins ?? [] });

/**
 * The per-IP rate-limit key: the client's address (http.ts `clientIp`),
 * never a constant every caller would share. A request we can't place is
 * refused rather than pooled with others; behind Next or any proxy that
 * doesn't happen.
 */
function clientKey(req: Request): string {
  const ip = clientIp(req, configOrNull()?.trustedProxies ?? 0);
  if (!ip) throw new HttpError(400, "client_unidentified", "We couldn't tell where this request came from.");
  return ip;
}

/**
 * The dashboard's routes: a verified Privy session. Every handler under
 * `app/api` that a merchant's browser calls is exported through this.
 */
export function withMerchant<Ctx = unknown>(handler: (req: Request, merchant: AuthedMerchant, ctx: Ctx) => Promise<Response>) {
  return wrap<AuthedMerchant, Ctx>(authenticate, (req, merchant, ctx) => {
    // Writes are rate limited per merchant, so a script can't grow the store without bound.
    if (UNSAFE_METHODS.has(req.method.toUpperCase())) consume(LIMITS.dashboardWritesPerMerchant, merchant.userId);
    return handler(req, merchant, ctx);
  });
}

/** Server-to-server API (`/api/v1`): a secret key. */
export function withSecretKey<Ctx = unknown>(handler: Handler<KeyContext, Ctx>) {
  return wrap<KeyContext, Ctx>(authenticateSecretKey, handler);
}

/** Browser API for merchants' own pages: a publishable key, from any origin. */
export function withPublishableKey<Ctx = unknown>(handler: Handler<KeyContext, Ctx>) {
  return wrap<KeyContext, Ctx>(authenticatePublishableKey, handler, { cors: () => ({ kind: "any" }) });
}

/**
 * The relayer's front door for the Polaris app. There is no account token:
 * the buyer's own signature over the exact call is the credential, and the
 * relay verifies it (and simulates the call) before anything is sent. Rate
 * limited per IP here, and per signing account in the relay.
 */
export function withSignedRequest<Ctx = unknown>(handler: Handler<null, Ctx>) {
  return wrap<null, Ctx>(async () => null, handler, { cors: appCors, limit: LIMITS.relayPerIp });
}

/**
 * Public, read-only data the hosted checkout needs (never a secret, never
 * another merchant's book). Rate limited per IP. The health route has its
 * own, larger bucket (`{ limit: "health" }`), so checkout traffic can never
 * leave the dashboard unable to read what the server is connected to.
 */
export function withPublic<Ctx = unknown>(handler: Handler<null, Ctx>, options: { limit?: "public" | "health" } = {}) {
  const limit = options.limit === "health" ? LIMITS.healthPerIp : LIMITS.publicPerIp;
  return wrap<null, Ctx>(async () => null, handler, { cors: appCors, limit });
}

/** Whether the request carries `Authorization: Bearer <CRON_SECRET>` (constant time; false when unset). */
export function hasCronSecret(req: Request): boolean {
  const secret = getConfig().cronSecret;
  if (!secret) return false;
  const a = Buffer.from(bearer(req) ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Scheduler routes: `Authorization: Bearer <CRON_SECRET>`. Closed when unset. */
export function withCron<Ctx = unknown>(handler: Handler<null, Ctx>) {
  return wrap<null, Ctx>(async (req) => {
    if (!getConfig().cronSecret) throw new HttpError(503, "not_configured", "CRON_SECRET isn't set, so scheduled jobs are closed.");
    if (!hasCronSecret(req)) throw new HttpError(401, "unauthenticated", "Wrong cron secret.");
    return null;
  }, handler);
}

/**
 * The CRE workflows' signed callbacks: `Polaris-Signature: t=<unix>,v1=<hex
 * HMAC-SHA256(POLARIS_CRE_CALLBACK_SECRET, "<t>.<body>")>`, within 300 s
 * (the scheme in @polaris/cre-workflows/callback). The handler gets the raw
 * body it was verified over. Closed when the secret is unset.
 */
export function withCreCallback<Ctx = unknown>(handler: (req: Request, body: string, ctx: Ctx, meta: { requestId: string }) => Promise<Response>) {
  return wrap<string, Ctx>(async (req) => {
    const secret = getConfig().cre.callbackSecret;
    if (!secret) throw new HttpError(503, "not_configured", "POLARIS_CRE_CALLBACK_SECRET isn't set, so CRE callbacks are closed.");
    const body = await readText(req);
    const check = verifyCreSignature(secret, body, req.headers.get("polaris-signature"), Math.floor(Date.now() / 1000));
    if (!check.ok) throw new HttpError(401, "bad_signature", `The callback's signature didn't verify: ${check.reason}.`);
    return body;
  }, handler, { limit: LIMITS.publicPerIp });
}

/** CORS preflight for the cross-origin routes. */
export function withPreflight(policy: "app" | "any") {
  return async function options(req: Request): Promise<Response> {
    return preflight(req, policy === "any" ? { kind: "any" } : { kind: "list", origins: getConfig().appOrigins });
  };
}

/** For routes that need the payout wallet to exist before they can act. */
export function requireWallet(merchant: AuthedMerchant): Address {
  if (!merchant.walletAddress) {
    throw new HttpError(409, "wallet_pending", "Your payout account is still being set up. Try again in a moment.");
  }
  return merchant.walletAddress;
}
