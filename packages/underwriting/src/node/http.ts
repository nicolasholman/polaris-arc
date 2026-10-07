/**
 * One HTTP path for every provider: timeouts, retries with backoff,
 * Retry-After, a per-provider rate limiter and a short cache.
 *
 * What retries: network errors, timeouts, 408, 425, 429 and 5xx. Zerion's
 * first request for a wallet is a 503 with Retry-After while it computes the
 * wallet (data.md §8), and Nansen's 429 carries `retry_after`. What does not:
 * every other 4xx, which is returned to the client to interpret (Zerion's
 * "not trackable" 400 is a known empty; Nansen's 403 `insufficient_credits`
 * is a failure the collector falls back from).
 *
 * A server that asks us to wait longer than `maxRetryAfterMs` is not waited
 * for: a buyer is at checkout. The error carries the wait so the service can
 * tell the app when to retry.
 */

import type { RequestSpec } from "../core/providers/common.ts";

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Lowercased names. */
  headers: Record<string, string>;
  body: string;
}

export type HttpTransport = (req: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>;

/** The live transport: `fetch`, never following redirects (CRE does not either). */
export const fetchTransport: HttpTransport = async (req, signal) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal,
    redirect: "manual",
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RetryPolicy {
  /** Total tries, including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Per attempt. CRE's HTTP cap is 10 s, so the same here. */
  timeoutMs: number;
  /** Longest Retry-After worth waiting for at checkout. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 4_000,
  timeoutMs: 10_000,
  maxRetryAfterMs: 12_000,
};

export type ProviderErrorCode =
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "retry_after_too_long"
  | "unauthorized"
  | "insufficient_credits"
  | "bad_request"
  /** Nansen refused the body we built (a field name, value or range): fix the request, do not retry. */
  | "request_rejected"
  | "not_found"
  /** The provider has no API key here: nothing was sent, and nothing answers in its place. */
  | "not_configured"
  | "parse_error"
  | "http_error";

export class ProviderError extends Error {
  readonly provider: string;
  readonly endpoint: string;
  readonly status: number | null;
  readonly code: ProviderErrorCode;
  /** Worth trying again later (the service turns it into retryAfterSeconds). */
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly attempts: number;

  constructor(init: {
    provider: string;
    endpoint: string;
    status: number | null;
    code: ProviderErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number | null;
    attempts?: number;
  }) {
    super(`${init.provider}.${init.endpoint}: ${init.message}`);
    this.name = "ProviderError";
    this.provider = init.provider;
    this.endpoint = init.endpoint;
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.attempts = init.attempts ?? 1;
  }
}

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Retry-After as seconds or an HTTP date, else a JSON body's `retry_after` (Nansen). */
export function retryAfterMs(res: HttpResponse, nowMs: number): number | null {
  const h = res.headers["retry-after"];
  if (h !== undefined) {
    if (/^\d+(\.\d+)?$/.test(h.trim())) return Math.ceil(Number(h) * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  try {
    const body = JSON.parse(res.body) as { retry_after?: unknown };
    if (typeof body.retry_after === "number" && body.retry_after >= 0) return Math.ceil(body.retry_after * 1000);
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Spaces request starts at least `minIntervalMs` apart, per provider, so a
 * burst of parallel collectors stays inside the plan's rate (Zerion's free
 * tier is 3 per second, Etherscan's 3, Nansen's 15).
 */
export class RateLimiter {
  private next = 0;
  private readonly minIntervalMs: number;
  private readonly clock: Clock;

  constructor(minIntervalMs: number, clock: Clock = systemClock) {
    this.minIntervalMs = minIntervalMs;
    this.clock = clock;
  }

  async acquire(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = this.clock.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minIntervalMs;
    if (at > now) await this.clock.sleep(at - now);
  }
}

/** Successful responses, keyed by the request without its secrets, for `ttlMs`. */
export class TtlCache {
  private readonly entries = new Map<string, { at: number; res: HttpResponse }>();
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly maxEntries: number;

  constructor(ttlMs: number, clock: Clock = systemClock, maxEntries = 2_000) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.maxEntries = maxEntries;
  }

  get(key: string): HttpResponse | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.clock.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.res;
  }

  set(key: string, res: HttpResponse): void {
    if (this.ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { at: this.clock.now(), res });
  }
}

export interface SendOptions {
  transport: HttpTransport;
  retry?: Partial<RetryPolicy>;
  clock?: Clock;
  limiter?: RateLimiter;
  cache?: TtlCache;
  /** Adds secrets (headers, or Etherscan's query parameter) just before sending. */
  authorize?: (req: HttpRequest) => HttpRequest;
  /** Jitter source in [0, 1). Injected in tests. */
  random?: () => number;
  /** Observes every response, for credit accounting and logs. */
  onResponse?: (spec: RequestSpec, res: HttpResponse, attempt: number) => void;
}

/**
 * Send `spec`, retrying what is worth retrying. Returns the first response
 * that is not retryable (any 2xx, and every 4xx but 408/425/429); throws a
 * ProviderError when retries run out, the wait is too long, or the transport
 * keeps failing.
 */
export async function send(spec: RequestSpec, opts: SendOptions): Promise<HttpResponse> {
  const policy = { ...DEFAULT_RETRY, ...opts.retry };
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? Math.random;
  const key = `${spec.method} ${spec.url} ${spec.headers["X-Env"] ?? ""} ${spec.body ?? ""}`;

  const cached = opts.cache?.get(key);
  if (cached) return cached;

  const base: HttpRequest = { method: spec.method, url: spec.url, headers: { ...spec.headers }, body: spec.body };
  const req = opts.authorize ? opts.authorize(base) : base;
  const fail = (init: Omit<ConstructorParameters<typeof ProviderError>[0], "provider" | "endpoint">) =>
    new ProviderError({ provider: spec.provider, endpoint: spec.endpoint, ...init });

  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    await opts.limiter?.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    let res: HttpResponse;
    try {
      res = await opts.transport(req, controller.signal);
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) throw err;
      const timedOut = controller.signal.aborted;
      lastError = fail({
        status: null,
        code: timedOut ? "timeout" : "network",
        message: timedOut ? `timed out after ${policy.timeoutMs} ms` : `network error: ${(err as Error).message}`,
        retryable: true,
        attempts: attempt,
      });
      if (attempt < policy.attempts) await clock.sleep(backoff(policy, attempt, random));
      continue;
    } finally {
      clearTimeout(timer);
    }

    opts.onResponse?.(spec, res, attempt);

    if (!RETRY_STATUSES.has(res.status)) {
      if (res.status >= 200 && res.status < 300) opts.cache?.set(key, res);
      return res;
    }

    const wait = retryAfterMs(res, clock.now());
    const code: ProviderErrorCode = res.status === 429 ? "rate_limited" : res.status === 408 ? "timeout" : "server_error";
    if (wait !== null && wait > policy.maxRetryAfterMs) {
      throw fail({
        status: res.status,
        code: "retry_after_too_long",
        message: `asked to wait ${Math.ceil(wait / 1000)} s`,
        retryable: true,
        retryAfterMs: wait,
        attempts: attempt,
      });
    }
    lastError = fail({
      status: res.status,
      code,
      message: `HTTP ${res.status}`,
      retryable: true,
      retryAfterMs: wait,
      attempts: attempt,
    });
    if (attempt < policy.attempts) await clock.sleep(wait ?? backoff(policy, attempt, random));
  }
  throw lastError ?? fail({ status: null, code: "network", message: "no attempt made", retryable: true });
}

function backoff(policy: RetryPolicy, attempt: number, random: () => number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  // Full jitter on the upper half, so parallel collectors do not retry in lockstep.
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Parse a response body as JSON, or throw a ProviderError naming the endpoint. */
export function jsonBody(spec: RequestSpec, res: HttpResponse): unknown {
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ProviderError({
      provider: spec.provider,
      endpoint: spec.endpoint,
      status: res.status,
      code: "parse_error",
      message: "response is not JSON",
      retryable: false,
    });
  }
}

/** A ProviderError for a non-2xx response the client did not expect. */
export function statusError(spec: RequestSpec, res: HttpResponse, detail?: string): ProviderError {
  const code: ProviderErrorCode =
    res.status === 401 ? "unauthorized" : res.status === 403 ? "insufficient_credits" : res.status === 404 ? "not_found" : res.status === 400 || res.status === 422 ? "bad_request" : "http_error";
  return new ProviderError({
    provider: spec.provider,
    endpoint: spec.endpoint,
    status: res.status,
    code,
    message: detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`,
    retryable: false,
  });
}
