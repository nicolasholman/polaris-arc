/**
 * polarispay-sdk: the browser client and everything shared.
 *
 * Deliberately free of React (that's `polarispay-sdk/react`) and of anything
 * that holds a secret key (that's `polarispay-sdk/server`). ethers is loaded
 * only when a wallet method runs, so opening the hosted checkout costs a page
 * a few kilobytes.
 */

export { createPolaris } from "./client.js";
export type { Polaris, PolarisOptions } from "./client.js";

export {
  AUSD,
  CHAINS,
  MONAD,
  MONAD_TESTNET,
  SEPOLIA,
  ZERO_ADDRESS,
  assertDeployed,
  chainById,
  explorerTxUrl,
  isDeployed,
  isZeroAddress,
  resolveChain,
} from "./chains.js";
export type { PolarisChain, PolarisContracts } from "./chains.js";
export { DEPLOYMENTS } from "./deployments.js";
export type { DeploymentRecord } from "./deployments.js";

export {
  DEFAULT_CHECKOUT_ORIGIN,
  DEV_CHECKOUT_ORIGIN,
  defaultCheckoutOrigin,
  resolveCheckoutUrl,
} from "./checkout/browser.js";
export type { CheckoutDisplay, CheckoutSource, OpenCheckoutOptions } from "./checkout/browser.js";
export {
  CHECKOUT_MESSAGE_TYPE,
  CHECKOUT_PROTOCOL_VERSION,
  createCheckoutMessage,
  parseCheckoutMessage,
} from "./checkout/protocol.js";
export type { CheckoutMessage, CheckoutMessageEvent, ParsedCheckoutMessage } from "./checkout/protocol.js";
export type {
  CheckoutCompleted,
  CheckoutPaymentStatus,
  CheckoutResult,
  CheckoutResultStatus,
  CheckoutSession,
  CheckoutSessionCreateParams,
  CheckoutSessionPayment,
  CheckoutSessionStatus,
  CheckoutTarget,
  LineItem,
  RequestOptions,
  SessionLineItem,
  SubscriptionInterval,
  SubscriptionTerms,
} from "./checkout/types.js";

export { WEBHOOK_EVENT_TYPES, isWebhookEventType } from "./events.js";
export type * from "./events.js";
export { assertWebhookEvent, validateWebhookEvent } from "./event-shape.js";
export type { WebhookEventProblem } from "./event-shape.js";

export { PAY_IN_4, formatUsd, normaliseAmount, quotePayIn4 } from "./money.js";
export { splitLink } from "./splits.js";
export type { SplitLinkParams, SplitShareInput, SplitStatus } from "./splits.js";
export { CREDIT_PAUSED_MESSAGE } from "./credit.js";
export type { CreditGuardReason, CreditGuardStatus } from "./credit.js";
export type { AmountInput, PayIn4Installment, PayIn4Options, PayIn4Quote } from "./money.js";

export type { PayParams, PayResult, PayStage, RelayPayRequest, RelayPayResponse, Result } from "./pay/direct.js";
export type { CreditProfile } from "./legacy.js";

export { PolarisError, PolarisSignatureVerificationError, isPolarisError } from "./errors.js";
export type { PolarisErrorType, SignatureFailureReason } from "./errors.js";
export { parseKey } from "./keys.js";
export type { KeyKind, KeyMode, ParsedKey } from "./keys.js";

export { CHECKOUT_MODES } from "./types.js";
export type { Address, CheckoutMode, ContractName, Eip1193Provider, Hex } from "./types.js";
export { VERSION } from "./version.js";
