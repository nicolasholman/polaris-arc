import type {
  ApiKey,
  Capabilities,
  AutoPayouts,
  AutoPayoutsInput,
  CreateApiKeyInput,
  CreatedApiKey,
  CreatedWebhookEndpoint,
  CreateLinkInput,
  CreateWebhookInput,
  Merchant,
  Overview,
  Payment,
  PaymentLink,
  PayoutsState,
  Plan,
  RegistrationStep,
  WebhookDelivery,
  WebhookEndpoint,
  WebhooksState,
  WithdrawInput,
  Payout,
} from "./types";

import type { ChainlinkOverview } from "./chainlink";
import type { CreditGuard } from "./guard";

/** What "Pay out now" did: paid, skipped (nothing to send) or failed, in words. */
export type PayoutRun = { result: "paid" | "skipped" | "failed"; detail?: string };

/**
 * Everything the dashboard reads or writes, as one interface.
 *
 * Pages depend on this and nothing else. It is implemented over our own
 * authenticated API routes (`http.ts`).
 */
export interface DashboardData {
  /** What this server is connected to (chain, relayer, payout signer). */
  getCapabilities(): Promise<Capabilities>;

  getMerchant(): Promise<Merchant>;
  updateMerchant(input: { businessName: string }): Promise<Merchant>;
  /** On-chain registration: the state and, when needed, the typed data to sign. */
  getRegistration(): Promise<RegistrationStep>;
  /** With the signed Registration; with neither field, a registered merchant's activation is tried again. */
  submitRegistration(input: { signature?: `0x${string}`; deadline?: string }): Promise<{ merchant: Merchant }>;

  getOverview(): Promise<Overview>;

  /**
   * The Chainlink page: the CRE workflows, their latest reports on Monad and
   * the credit guard. On a server with nothing deployed, `deployed: false`
   * and no workflows.
   */
  getChainlink(): Promise<ChainlinkOverview>;
  /** The credit guard now: whether new Pay in 4 plans are paused, and why. */
  getCreditGuard(): Promise<CreditGuard>;

  listLinks(): Promise<PaymentLink[]>;
  createLink(input: CreateLinkInput): Promise<PaymentLink>;
  /** Turn a link off. Links are never deleted. */
  deactivateLink(linkId: string): Promise<PaymentLink>;

  listPayments(): Promise<Payment[]>;
  listPlans(): Promise<Plan[]>;

  getPayouts(): Promise<PayoutsState>;
  withdraw(input: WithdrawInput): Promise<Payout>;
  setAutoPayouts(input: AutoPayoutsInput): Promise<AutoPayouts>;
  /** Run the automatic payout now, under the merchant's payout policy. */
  payoutNow(): Promise<PayoutRun>;

  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey>;
  revokeApiKey(keyId: string): Promise<ApiKey>;

  listWebhooks(): Promise<WebhooksState>;
  createWebhook(input: CreateWebhookInput): Promise<CreatedWebhookEndpoint>;
  /** Remove an endpoint; deliveries still queued for it are dropped. */
  deleteWebhook(endpointId: string): Promise<WebhookEndpoint>;
  /** Sign and send a test `payment.succeeded`, exactly as a live one. */
  sendTestEvent(endpointId: string): Promise<WebhookDelivery>;
  /** Send a delivery again now, from the log. */
  retryDelivery(deliveryId: string): Promise<WebhookDelivery>;
}

/** An error the API returned on purpose, with a message fit to show a person. */
export class DataError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** The request field a validation error is about (`param`), to mark in a form. */
    readonly field?: string,
  ) {
    super(message);
    this.name = "DataError";
  }
}

/** A session that is over: sign the person out and send them to sign in. */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof DataError && error.status === 401 && (error.code === "unauthenticated" || error.code === "invalid_token");
}

/** The message to show for anything a data call threw. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  if (error instanceof DataError) {
    if (error.code === "auth_not_configured") return "Sign-in isn't configured on this server yet, so your data can't load.";
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
