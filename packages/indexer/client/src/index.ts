/**
 * @polarispay/indexer-client: typed access to the Polaris Envio indexer for
 * the dashboard, the webhook dispatcher, the CRE collections workflow and the
 * Polaris app. See ../README.md.
 */

export { createIndexerClient, type IndexerClient, type IndexerClientOptions, type Page } from "./client.ts";
export { createTransport, IndexerError, serializeVariables, type FetchLike, type Request, type TransportOptions } from "./http.ts";
export * as documents from "./documents.ts";
export { BIGINT_FIELDS, decode, toBigInt } from "./decode.ts";
export {
  CHECK_TASKS_SIGNATURE,
  COLLECTION_ACTION,
  dueCandidatesRequest,
  MAX_TASKS_PER_READ,
  parseDueCandidates,
  readyTasks,
  REPORT_ABI_PARAMETERS,
  REPORT_KIND_COLLECTIONS,
  type CollectionAction,
  type Task,
} from "./cre.ts";
export {
  committed,
  failureReasonOf,
  IncompleteActivityError,
  nextCursor,
  toWebhookEvent,
  webhookEventId,
  webhookSourceKey,
  type InstallmentCollectedData,
  type InstallmentFailedData,
  type PaymentSucceededData,
  type PayoutPaidData,
  type PlanCompletedData,
  type PlanInstallment,
  type PlanLiquidatedData,
  type PlanOpenedData,
  type SubscriptionCanceledData,
  type SubscriptionChargedData,
  type WebhookContext,
  type WebhookEvent,
  type WebhookEventDataMap,
  type WebhookEventType,
  type WebhookSession,
} from "./webhooks.ts";
export { assertWebhookEvent, validateWebhookEvent, type WebhookEventProblem } from "./sdk-event-shape.ts";
export { AUSD_DECIMALS, formatAmount, formatUsd, fromCents, toCents } from "./money.ts";
export { installmentSlice, thresholdFor } from "./loans.ts";
export { checksumAddress, keccak256Hex, sha256Hex } from "./hash.ts";
export { availableCredit, baseLimitOf, creditLimitOf, securedOnly, type CreditInputs, type CreditSettings } from "./credit.ts";
export * from "./types.ts";
