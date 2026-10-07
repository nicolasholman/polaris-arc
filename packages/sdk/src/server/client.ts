import type { CheckoutSession, CheckoutSessionCreateParams, RequestOptions } from "../checkout/types.js";
import type { CreditGuardStatus } from "../credit.js";
import { configurationError, invalidRequest } from "../errors.js";
import type { WebhookEvent } from "../events.js";
import { requireSecretKey } from "../keys.js";
import { assertSplitId, type SplitStatus } from "../splits.js";
import { assertSessionId, buildCreateBody } from "./checkout-params.js";
import { createHttpClient, type HttpClientOptions } from "./http.js";
import {
  generateTestHeader,
  verifyWebhook,
  verifyWebhookAsync,
  type RawBody,
  type SignatureHeader,
  type VerifyOptions,
} from "./webhooks.js";

/**
 * The server client. Keep it on the server: it holds your secret key.
 *
 *   const polaris = createPolarisServer({ secretKey: process.env.POLARIS_SECRET_KEY!, baseUrl: process.env.POLARIS_BASE_URL! });
 *   const session = await polaris.checkout.sessions.create({ amount: "200.00", description: "…", successUrl: "…" }, { idempotencyKey: order.id });
 *   redirect(session.url);
 */

export type PolarisServerOptions = {
  /** sk_test_… or sk_live_…, from Developers → API keys in Polaris for Business. */
  secretKey: string;
  /**
   * The Polaris API origin: your Polaris for Business deployment, e.g.
   * http://localhost:3100 when running the dashboard locally.
   */
  baseUrl: string;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Retries for network errors, 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** Default tolerance for `webhooks.verify`, in seconds. Default 300. */
  webhookToleranceSeconds?: number;
  /** Allow construction in a browser. Don't: it would ship your secret key to every visitor. */
  dangerouslyAllowBrowser?: boolean;
  /** @internal For tests. */
  sleep?: HttpClientOptions["sleep"];
};

export interface PolarisServer {
  readonly livemode: boolean;
  readonly baseUrl: string;
  checkout: {
    sessions: {
      /** POST /api/v1/checkout/sessions */
      create(params: CheckoutSessionCreateParams, options?: RequestOptions): Promise<CheckoutSession>;
      /** GET /api/v1/checkout/sessions/{id} */
      retrieve(id: string, options?: Omit<RequestOptions, "idempotencyKey">): Promise<CheckoutSession>;
    };
  };
  credit: {
    /**
     * GET /api/public/credit-guard: whether buyers can start a new Pay in 4
     * plan right now. While `paused`, show Pay in 4 as unavailable with
     * `message` and keep Pay now; the hosted checkout does the same.
     */
    guard(options?: Omit<RequestOptions, "idempotencyKey">): Promise<CreditGuardStatus>;
  };
  splits: {
    /**
     * GET /api/public/splits/{id}: a split-the-bill link's status (each
     * share's amount, whether and when it was paid, open, settled, closed or
     * expired), from PolarisSplit on chain. Its words (what it's for, the
     * names) are the organiser's and travel only in the link.
     */
    retrieve(id: string, options?: Omit<RequestOptions, "idempotencyKey">): Promise<SplitStatus>;
  };
  webhooks: {
    /**
     * Verify a delivery and return its event. Throws
     * PolarisSignatureVerificationError when it doesn't verify.
     */
    verify(rawBody: RawBody, signatureHeader: SignatureHeader, secret: string, options?: VerifyOptions): WebhookEvent;
    /** The same through Web Crypto. */
    verifyAsync(rawBody: RawBody, signatureHeader: SignatureHeader, secret: string, options?: VerifyOptions): Promise<WebhookEvent>;
    /** A valid Polaris-Signature header for `payload`, to test your handler. */
    generateTestHeader(args: { payload: string; secret: string; timestamp?: number }): string;
  };
}

function inBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== "undefined" && typeof g.document !== "undefined";
}

function normaliseBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configurationError(
      "missing_base_url",
      "createPolarisServer needs baseUrl: your Polaris for Business API origin (http://localhost:3100 for the local dashboard).",
      "baseUrl",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("invalid_base_url", `baseUrl must be an absolute URL, got ${JSON.stringify(value)}.`, "baseUrl");
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw configurationError("insecure_base_url", "baseUrl must use https (http is allowed for localhost only): your secret key travels in every request.", "baseUrl");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function randomKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return `sdk_${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `sdk_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function createPolarisServer(options: PolarisServerOptions): PolarisServer {
  if (!options || typeof options !== "object") {
    throw configurationError("missing_options", "createPolarisServer({ secretKey, baseUrl })");
  }
  if (inBrowser() && !options.dangerouslyAllowBrowser) {
    throw configurationError(
      "server_sdk_in_browser",
      "createPolarisServer runs on your server only: it holds your secret key. In the browser, use createPolaris({ publishableKey }).",
    );
  }
  const key = requireSecretKey(options.secretKey);
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const http = createHttpClient({
    secretKey: options.secretKey.trim(),
    baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    sleep: options.sleep,
  });
  const tolerance = options.webhookToleranceSeconds;

  return {
    livemode: key.livemode,
    baseUrl,
    checkout: {
      sessions: {
        async create(params, requestOptions = {}) {
          const body = buildCreateBody(params);
          const idempotencyKey = requestOptions.idempotencyKey ?? randomKey();
          if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 255) {
            throw invalidRequest("invalid_idempotency_key", "idempotencyKey must be 1 to 255 characters.", "idempotencyKey");
          }
          return http.request<CheckoutSession>({
            method: "POST",
            path: "/api/v1/checkout/sessions",
            body,
            idempotencyKey,
            timeoutMs: requestOptions.timeoutMs,
            signal: requestOptions.signal,
          });
        },
        async retrieve(id, requestOptions = {}) {
          const sessionId = assertSessionId(id);
          return http.request<CheckoutSession>({
            method: "GET",
            path: `/api/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
            timeoutMs: requestOptions.timeoutMs,
            signal: requestOptions.signal,
          });
        },
      },
    },
    credit: {
      async guard(requestOptions = {}) {
        return http.request<CreditGuardStatus>({
          method: "GET",
          path: "/api/public/credit-guard",
          timeoutMs: requestOptions.timeoutMs,
          signal: requestOptions.signal,
        });
      },
    },
    splits: {
      async retrieve(id, requestOptions = {}) {
        return http.request<SplitStatus>({
          method: "GET",
          path: `/api/public/splits/${assertSplitId(id)}`,
          timeoutMs: requestOptions.timeoutMs,
          signal: requestOptions.signal,
        });
      },
    },
    webhooks: {
      verify: (rawBody, header, secret, verifyOptions) =>
        verifyWebhook(rawBody, header, secret, { toleranceSeconds: tolerance, ...verifyOptions }),
      verifyAsync: (rawBody, header, secret, verifyOptions) =>
        verifyWebhookAsync(rawBody, header, secret, { toleranceSeconds: tolerance, ...verifyOptions }),
      generateTestHeader,
    },
  };
}
