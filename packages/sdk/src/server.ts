/**
 * polarispay-sdk/server: checkout sessions, split status and webhook verification.
 *
 * Holds your secret key, so it refuses to run in a browser. No static Node
 * imports: it works on Node, edge runtimes, Bun and Deno.
 */

export { createPolarisServer } from "./server/client.js";
export type { PolarisServer, PolarisServerOptions } from "./server/client.js";

export {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  generateTestHeader,
  signWebhookPayload,
  verifyWebhook,
  verifyWebhookAsync,
} from "./server/webhooks.js";
export type { RawBody, SignatureHeader, VerifyOptions } from "./server/webhooks.js";

export type { CheckoutSessionCreateBody } from "./server/checkout-params.js";
export type { SplitStatus } from "./splits.js";

export type {
  CheckoutSession,
  CheckoutSessionCreateParams,
  CheckoutSessionPayment,
  CheckoutSessionStatus,
  CheckoutPaymentStatus,
  LineItem,
  RequestOptions,
  SessionLineItem,
  SubscriptionInterval,
  SubscriptionTerms,
} from "./checkout/types.js";
export { WEBHOOK_EVENT_TYPES, isWebhookEventType } from "./events.js";
export type * from "./events.js";
export { PolarisError, PolarisSignatureVerificationError, isPolarisError } from "./errors.js";
export type { PolarisErrorType, SignatureFailureReason } from "./errors.js";
export { MONAD, MONAD_TESTNET } from "./chains.js";
export { VERSION } from "./version.js";
export { CREDIT_PAUSED_MESSAGE } from "./credit.js";
export type { CreditGuardReason, CreditGuardStatus } from "./credit.js";
