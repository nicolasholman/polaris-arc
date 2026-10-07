/**
 * `@polarispay/underwriting`: the pure core plus the Node side (provider
 * clients, the evidence collector, the service and the HTTP handler).
 *
 * The Polaris keeper calls `Underwriter.fromEnv().assess(...)`. For the pure
 * half alone (Facts, scores, report bytes) import `@polarispay/underwriting/core`:
 * it has no Node dependency. Test doubles for the provider APIs (fixture files and
 * transports) are in `@polarispay/underwriting/testing`, for tests only.
 */

export * from "../core/index.ts";

export {
  fetchTransport,
  send,
  RateLimiter,
  TtlCache,
  ProviderError,
  DEFAULT_RETRY,
  systemClock,
  retryAfterMs,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type RetryPolicy,
  type ProviderErrorCode,
} from "./http.ts";
export type { ClientOptions } from "./client.ts";
export { NansenClient } from "./nansen.ts";
export { ZerionClient } from "./zerion.ts";
export { EtherscanClient } from "./etherscan.ts";
export { RpcClient } from "./rpc.ts";
export { BlockscoutClient } from "./blockscout.ts";
export { collectAccount, collectLinked, sender, type Providers, type CollectOptions } from "./collect.ts";
export {
  Underwriter,
  CreditMeter,
  verifyLinkProof,
  accountChainFromEnv,
  SERVICE_VERSION,
  type AccountChain,
  type AssessRequest,
  type Assessment,
  type NotConfigured,
  type UnderwriterOptions,
} from "./service.ts";
export { createRouter, createNodeHandler, createFetchHandler, type HandlerOptions, type RouteRequest, type RouteResponse } from "./handler.ts";
export { startUnderwritingServer, isLoopbackHost, isLoopbackAddress, assertSafeBind, type ServerOptions } from "./server.ts";
