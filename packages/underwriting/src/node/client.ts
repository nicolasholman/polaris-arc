/**
 * What every provider client shares: live or not configured, retries, the
 * rate limiter, the cache, and the credit log.
 *
 * There are two modes and no third. A keyed provider (Nansen, Zerion,
 * Etherscan) with its key is live; without one it is `not_configured`: every
 * call fails at once with a `not_configured` ProviderError naming the missing
 * variable, nothing is sent, and nothing answers in its place. Public RPCs
 * need no key and are always live.
 */

import { PROVIDER_KEYS } from "../core/constants.ts";
import type { RequestSpec } from "../core/providers/common.ts";
import type { KeyedProvider, ProviderMode } from "../core/types.ts";
import {
  fetchTransport,
  ProviderError,
  RateLimiter,
  send,
  systemClock,
  TtlCache,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type RetryPolicy,
} from "./http.ts";

export interface ClientOptions {
  /** The provider's key. A keyed provider without one is not configured. */
  apiKey?: string;
  /** Replace the network (tests). The mode still follows the key. */
  transport?: HttpTransport;
  retry?: Partial<RetryPolicy>;
  clock?: Clock;
  /** Minimum gap between request starts. */
  minIntervalMs?: number;
  /** How long successful responses are reused. 0 disables. Default 10 minutes, CRE's cache cap. */
  cacheTtlMs?: number;
  random?: () => number;
  /** Observes every response, for credit accounting and logs. */
  onResponse?: (spec: RequestSpec, res: HttpResponse, attempt: number) => void;
}

export abstract class ProviderClient {
  readonly mode: ProviderMode;
  readonly provider: KeyedProvider | "rpc";
  protected readonly apiKey: string | undefined;
  private readonly transport: HttpTransport;
  private readonly limiter: RateLimiter;
  private readonly cache: TtlCache;
  private readonly opts: ClientOptions;

  protected constructor(opts: ClientOptions, defaults: { minIntervalMs: number; provider: KeyedProvider | "rpc" }) {
    this.opts = opts;
    this.provider = defaults.provider;
    this.apiKey = opts.apiKey && opts.apiKey.trim() !== "" ? opts.apiKey.trim() : undefined;
    this.mode = defaults.provider === "rpc" || this.apiKey ? "live" : "not_configured";
    const clock = opts.clock ?? systemClock;
    this.transport = opts.transport ?? fetchTransport;
    this.limiter = new RateLimiter(opts.minIntervalMs ?? defaults.minIntervalMs, clock);
    this.cache = new TtlCache(opts.cacheTtlMs ?? 10 * 60_000, clock);
  }

  /** The variable that holds this provider's key, or null for a public RPC. */
  get keyVariable(): string | null {
    return this.provider === "rpc" ? null : PROVIDER_KEYS[this.provider];
  }

  /** Add this provider's secret to a request. */
  protected abstract authorize(req: HttpRequest): HttpRequest;

  /** Send a request built by the core (a recipe step): authorized, retried, rate-limited, cached. */
  execute(spec: RequestSpec): Promise<HttpResponse> {
    return this.request(spec);
  }

  protected request(spec: RequestSpec): Promise<HttpResponse> {
    if (this.mode === "not_configured") {
      return Promise.reject(
        new ProviderError({
          provider: this.provider,
          endpoint: spec.endpoint,
          status: null,
          code: "not_configured",
          message: `${this.provider} is not configured (${this.keyVariable} is not set)`,
          retryable: false,
        }),
      );
    }
    return send(spec, {
      transport: this.transport,
      retry: this.opts.retry,
      clock: this.opts.clock,
      limiter: this.limiter,
      cache: this.cache,
      random: this.opts.random,
      onResponse: this.opts.onResponse,
      authorize: this.apiKey ? (r) => this.authorize(r) : undefined,
    });
  }
}
