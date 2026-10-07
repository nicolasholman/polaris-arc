import "server-only";

import { centsToDecimal } from "@/lib/money";
import { payRefOf } from "@/lib/orders/access";
import type { Order, SdkCall } from "@/lib/orders/types";

import {
  createPolarisServer,
  type CheckoutSession,
  type CheckoutSessionCreateParams,
  type PolarisServer,
  type WebhookEvent,
} from "polarispay-sdk/server";

import type { BrowserPolarisConfig, LocalChain, ShopCreditGuard } from "./polaris-config";

export { PolarisError, PolarisSignatureVerificationError, isPolarisError } from "polarispay-sdk/server";
export type { CheckoutSession, WebhookEvent as PolarisEvent } from "polarispay-sdk/server";
// Pay in 4 pricing for server-rendered messaging: the loan engine's own maths.
export { quotePayIn4 } from "polarispay-sdk";

type Address = `0x${string}`;

/**
 * Every server-side Polaris call the shop makes goes through this file.
 *
 * Configuration, from the environment:
 *   POLARIS_API_BASE                     the Polaris API (e.g. http://localhost:3100)
 *   POLARIS_SECRET_KEY                   sk_test_… from Polaris for Business
 *   POLARIS_WEBHOOK_SECRET               whsec_… for /api/webhooks/polaris
 *   POLARIS_MERCHANT_ADDRESS             the store's payout address, for direct wallet payments
 *   POLARIS_RELAY_URL                    optional; defaults to {POLARIS_API_BASE}/api/v1/relay/payments
 *   NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY  pk_test_…
 *   NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN  where hosted checkout pages live (the Polaris app)
 *
 * Without POLARIS_API_BASE and the keys, the shop takes no payments: the
 * checkout says payments aren't configured and /api/health reports why. There
 * is no fallback; every payment goes through Polaris for Business.
 */

type Env = Record<string, string | undefined>;

export type PolarisConfig =
  | {
      ok: true;
      baseUrl: string;
      secretKey: string;
      webhookSecret: string;
      publishableKey: string;
      checkoutOrigin: string;
      relayUrl: string;
      merchant: Address;
    }
  | { ok: false; reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * The shop's Polaris settings, or why payments aren't configured. Every
 * setting is required (SHOP_URL in production too); nothing is filled in for
 * a missing one.
 */
export function resolvePolarisConfig(env: Env): PolarisConfig {
  const missing = [
    ["POLARIS_API_BASE", env.POLARIS_API_BASE],
    ["POLARIS_SECRET_KEY", env.POLARIS_SECRET_KEY],
    ["POLARIS_WEBHOOK_SECRET", env.POLARIS_WEBHOOK_SECRET],
    ["NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY", env.NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY],
    ["NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN", env.NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN],
    ["POLARIS_MERCHANT_ADDRESS", env.POLARIS_MERCHANT_ADDRESS],
    // In production, success and cancel URLs come from SHOP_URL, never from a request's Host header.
    ...(env.NODE_ENV === "production" ? [["SHOP_URL", env.SHOP_URL] as const] : []),
  ].filter(([, value]) => !value?.trim());
  if (missing.length > 0) {
    return { ok: false, reason: `Set ${missing.map(([name]) => name).join(", ")} to take payments through Polaris.` };
  }
  const apiBase = env.POLARIS_API_BASE!.trim();
  const checkoutOrigin = env.NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN!.trim();
  if (!isHttpUrl(apiBase)) return { ok: false, reason: "POLARIS_API_BASE must be an http(s) URL." };
  if (!isHttpUrl(checkoutOrigin)) return { ok: false, reason: "NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN must be an http(s) URL." };
  if (!ADDRESS.test(env.POLARIS_MERCHANT_ADDRESS!.trim())) {
    return { ok: false, reason: "POLARIS_MERCHANT_ADDRESS must be a 0x-prefixed address." };
  }
  const baseUrl = apiBase.replace(/\/+$/, "");
  return {
    ok: true,
    baseUrl,
    secretKey: env.POLARIS_SECRET_KEY!.trim(),
    webhookSecret: env.POLARIS_WEBHOOK_SECRET!.trim(),
    publishableKey: env.NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY!.trim(),
    checkoutOrigin: new URL(checkoutOrigin).origin,
    // The API's direct-pay relay route (apps/business: POST /api/v1/relay/payments).
    relayUrl: env.POLARIS_RELAY_URL?.trim() || `${baseUrl}/api/v1/relay/payments`,
    merchant: env.POLARIS_MERCHANT_ADDRESS!.trim() as Address,
  };
}

export function polarisConfig(): PolarisConfig {
  return resolvePolarisConfig(process.env);
}

const ADDRESS_FIELDS = [
  "stablecoin",
  "payments",
  "loanEngine",
  "scoreManager",
  "collateralVault",
  "checkout",
  "send",
  "merchantRegistry",
  "collector",
  "batchSettlement",
] as const;

/**
 * `pnpm demo:local`'s chain, from POLARIS_LOCAL_CHAIN (a JSON object: chainId,
 * name, rpcUrl, explorer and each Polaris contract). Development only: the
 * NODE_ENV test folds to false in a production build, so a deployed store
 * always pays on Monad. Null when unset or malformed.
 */
export function localChain(env: Env = process.env): LocalChain | null {
  if (process.env.NODE_ENV !== "development") return null;
  const raw = env.POLARIS_LOCAL_CHAIN?.trim();
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    if (!Number.isInteger(c.chainId) || typeof c.rpcUrl !== "string") return null;
    const zero = "0x0000000000000000000000000000000000000000";
    const addresses = Object.fromEntries(
      ADDRESS_FIELDS.map((k) => [k, typeof c[k] === "string" && ADDRESS.test(c[k] as string) ? c[k] : zero]),
    ) as Pick<LocalChain, (typeof ADDRESS_FIELDS)[number]>;
    return {
      chainId: c.chainId as number,
      name: typeof c.name === "string" ? c.name : "Local chain",
      rpcUrl: c.rpcUrl,
      explorer: typeof c.explorer === "string" ? c.explorer : "",
      ...addresses,
    };
  } catch {
    return null;
  }
}

/** What the browser may know: no secrets. Passed from server components as props. */
export function browserConfig(): BrowserPolarisConfig {
  const config = resolvePolarisConfig(process.env);
  const payInFourAprBps = payInFourApr();
  if (!config.ok) return { ok: false, reason: config.reason, payInFourAprBps };
  return {
    ok: true,
    publishableKey: config.publishableKey,
    checkoutOrigin: config.checkoutOrigin,
    relayUrl: config.relayUrl,
    payInFourAprBps,
    chain: localChain(process.env),
  };
}

/**
 * Pay in 4 pricing shown on the store, in basis points of APR: always
 * PolarisLoanEngine.INTEREST_RATE_BPS (1000, 10% APR), what the buyer is
 * actually charged. The engine has no other rate, so the store never quotes
 * one (and never an interest-free plan): POLARIS_PAY_IN_4_APR_BPS is read only
 * to warn when it disagrees.
 */
export const LOAN_ENGINE_APR_BPS = 1000;

export function payInFourApr(env: Env = process.env): number {
  const raw = env.POLARIS_PAY_IN_4_APR_BPS?.trim();
  if (raw && Number(raw) !== LOAN_ENGINE_APR_BPS && !warnedApr) {
    warnedApr = true;
    console.warn(`POLARIS_PAY_IN_4_APR_BPS=${raw} is ignored: Polaris Pay in 4 is ${LOAN_ENGINE_APR_BPS / 100}% APR (PolarisLoanEngine).`);
  }
  return LOAN_ENGINE_APR_BPS;
}
let warnedApr = false;

let cached: { key: string; server: PolarisServer } | null = null;

function server(config: Extract<PolarisConfig, { ok: true }>): PolarisServer {
  const key = `${config.baseUrl}|${config.secretKey}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      server: createPolarisServer({
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        // Looked up per request, so tests and instrumentation can patch fetch after the client exists.
        fetch: (input, init) => globalThis.fetch(input, init),
      }),
    };
  }
  return cached.server;
}

let guardCache: { key: string; at: number; value: Promise<ShopCreditGuard | null> } | null = null;

/** Tests: forget the last read. */
export function resetCreditGuardCache(): void {
  guardCache = null;
}

/**
 * Polaris's risk guard (`polaris.credit.guard()`): whether buyers can start
 * a new Pay in 4 plan. Read at most every 10 s, and never allowed to hold a
 * page up: past 2.5 s, or on any error, it is null, which the store treats
 * as open (the hosted checkout and the chain still apply the real answer).
 */
export async function creditGuard(): Promise<ShopCreditGuard | null> {
  const config = resolvePolarisConfig(process.env);
  if (!config.ok) return null;
  const key = config.baseUrl;
  if (guardCache && guardCache.key === key && Date.now() - guardCache.at < 10_000) return guardCache.value;
  const read = server(config)
    .credit.guard({ timeoutMs: 2_500 })
    .then((g): ShopCreditGuard => ({ paused: g.paused, message: g.paused ? g.message : null, state: g.state }))
    .catch(() => null);
  const value = Promise.race([read, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500))]);
  guardCache = { key, at: Date.now(), value };
  return value;
}

/** The checkout session parameters for an order: exactly what gets sent, and what the drawer shows. */
export function sessionParamsFor(order: Order, origin: string): CheckoutSessionCreateParams {
  const mode = order.payment.requestedMode ?? "now";
  const lineItems: NonNullable<CheckoutSessionCreateParams["lineItems"]> = order.lines.map((line) => ({
    name: `${line.name}, ${line.optionValue}`,
    quantity: line.quantity,
    unitAmount: centsToDecimal(line.unitPrice),
  }));
  if (order.shipping > 0) lineItems.push({ name: "Delivery", quantity: 1, unitAmount: centsToDecimal(order.shipping) });
  return {
    amount: centsToDecimal(order.total),
    currency: "USD",
    // The merchant's order number rides in the description, so Polaris (the dashboard, the Envio feed, the buyer's app) shows it.
    description: order.kind === "subscription" ? `Halcyon Coffee Club, monthly · ${order.number}` : `Halcyon order ${order.number}`,
    lineItems,
    // The first mode is the one the checkout opens on. Pay in 4 keeps Pay now
    // as a fallback, so a buyer whose plan isn't approved can still finish.
    modes: mode === "later" ? ["later", "now"] : [mode],
    ...(order.kind === "subscription" ? { subscription: { interval: "month" as const, intervalCount: 1 } } : {}),
    successUrl: `${origin}/orders/${order.id}?via=polaris`,
    // A subscription checks out on its own page, which the cancel URL has to name to come back to it.
    cancelUrl:
      order.kind === "subscription" && order.lines[0]
        ? `${origin}/checkout?subscribe=${order.lines[0].productId}&option=${order.lines[0].optionId}&canceled=1`
        : `${origin}/checkout?order=${order.id}&canceled=1`,
    // Echoed back as data.orderId on every webhook for this session. The
    // payRef, not the order id: Polaris may write it on chain.
    orderId: payRefOf(order),
    metadata: { orderNumber: order.number },
  };
}

export async function createCheckoutSession(
  order: Order,
  origin: string,
): Promise<{ session: CheckoutSession; log: SdkCall }> {
  const config = polarisConfig();
  if (!config.ok) throw new Error(config.reason);
  const params = sessionParamsFor(order, origin);
  const idempotencyKey = `${order.id}:session:${order.payment.sessionAttempt}`;
  const at = new Date().toISOString();
  try {
    const session = await server(config).checkout.sessions.create(params, { idempotencyKey });
    return {
      session,
      log: {
        at,
        side: "server",
        call: "polaris.checkout.sessions.create",
        args: [params, { idempotencyKey }],
        result: { id: session.id, url: session.url, status: session.status, expiresAt: session.expiresAt },
      },
    };
  } catch (error) {
    (error as { sdkLog?: SdkCall }).sdkLog = {
      at,
      side: "server",
      call: "polaris.checkout.sessions.create",
      args: [params, { idempotencyKey }],
      error: (error as Error).message,
    };
    throw error;
  }
}

export async function retrieveCheckoutSession(id: string): Promise<{ session: CheckoutSession; log: SdkCall }> {
  const config = polarisConfig();
  if (!config.ok) throw new Error(config.reason);
  const session = await server(config).checkout.sessions.retrieve(id);
  return {
    session,
    log: {
      at: new Date().toISOString(),
      side: "server",
      call: "polaris.checkout.sessions.retrieve",
      args: [id],
      result: { id: session.id, status: session.status, paymentStatus: session.paymentStatus, payment: session.payment },
    },
  };
}

/** Verify a delivery against the raw body. Throws PolarisSignatureVerificationError. */
export function verifyWebhook(rawBody: string, signature: string | null, now?: number): WebhookEvent {
  const config = polarisConfig();
  if (!config.ok) throw new Error(config.reason);
  return server(config).webhooks.verify(rawBody, signature, config.webhookSecret, now === undefined ? undefined : { now });
}

export function merchantAddress(): Address | null {
  const config = polarisConfig();
  return config.ok ? config.merchant : null;
}
