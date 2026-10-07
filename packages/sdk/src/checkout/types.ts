import type { Address, CheckoutMode, Hex } from "../types.js";

/* ── Checkout sessions: the HTTP contract ─────────────────────────────────
 *
 * These types are the JSON the API sends and receives, field for field. The
 * README's "HTTP API" section documents the same contract for anyone
 * implementing it or calling it without the SDK.
 */

export type LineItem = {
  /** What the buyer sees on the checkout and the receipt. */
  name: string;
  /** Whole units, 1 or more. Default 1. */
  quantity?: number;
  /** Price of one unit in USD: "150.00". */
  unitAmount: string;
};

/** A line item as the API returns it, with its extended amount. */
export type SessionLineItem = Required<LineItem> & { amount: string };

export type SubscriptionInterval = "day" | "week" | "month" | "year";

export type SubscriptionTerms = {
  /** How often the subscription charges `amount`. */
  interval: SubscriptionInterval;
  /** Every `intervalCount` intervals. Default 1. */
  intervalCount?: number;
};

export type CheckoutSessionCreateParams = {
  /**
   * Total in USD as a decimal string: "200.00". Optional when `lineItems` is
   * given (it is their sum); when both are given they must agree.
   */
  amount?: string | number;
  /** Only "USD": every Polaris payment settles in AUSD, a dollar. */
  currency?: "USD";
  /** One line the buyer sees under the merchant's name. Up to 500 characters. */
  description: string;
  lineItems?: LineItem[];
  /** How the buyer may pay. Default ["now", "later"]. */
  modes?: CheckoutMode[];
  /** Required when `modes` includes "subscribe"; `amount` is then the price per period. Default monthly. */
  subscription?: SubscriptionTerms;
  /**
   * Where the buyer lands after paying. `{CHECKOUT_SESSION_ID}` in the URL is
   * replaced with the session id. Fulfil from the webhook, not from this
   * redirect: a buyer can open the URL without paying.
   */
  successUrl: string;
  /** Where "Cancel" in the checkout takes the buyer. */
  cancelUrl?: string;
  /** Your own order reference, echoed back as `data.orderId` on every webhook for this session. */
  orderId?: string;
  /** Up to 20 keys (40 chars) of string values (500 chars), echoed on the session and its webhooks. */
  metadata?: Record<string, string>;
};

export type RequestOptions = {
  /**
   * Makes a retried create safe: the API returns the first session for a
   * repeated key instead of making a second one. Use your order id. The SDK
   * generates one per call when you don't, so its own retries are safe too.
   */
  idempotencyKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Abort the request. */
  signal?: AbortSignal;
};

export type CheckoutSessionStatus = "open" | "complete" | "expired";
export type CheckoutPaymentStatus = "unpaid" | "paid";

/** How a completed session was paid, from the indexed chain event. */
export type CheckoutSessionPayment = {
  mode: CheckoutMode;
  payer: Address;
  /** The transaction that settled it (the plan's opening for Pay in 4, the first charge for a subscription). */
  txHash: Hex;
  chainId: number;
  /** PolarisPayments payment id for "now": keccak256(merchant, orderId). */
  paymentId: Hex | null;
  /** PolarisLoanEngine loan id for "later". */
  planId: string | null;
  /** PolarisPayments subscription id for "subscribe". */
  subscriptionId: string | null;
};

export type CheckoutSession = {
  /** "cs_test_…" or "cs_live_…". */
  id: string;
  object: "checkout.session";
  /** The hosted checkout: https://pay.polarispay.app/pay/{id}. Send the buyer here. */
  url: string;
  status: CheckoutSessionStatus;
  paymentStatus: CheckoutPaymentStatus;
  livemode: boolean;
  amount: string;
  currency: "USD";
  description: string;
  lineItems: SessionLineItem[];
  modes: CheckoutMode[];
  subscription: Required<SubscriptionTerms> | null;
  successUrl: string;
  cancelUrl: string | null;
  orderId: string | null;
  metadata: Record<string, string>;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. An open session can't be paid after this. */
  expiresAt: string;
  /** ISO 8601, set when the session completes. */
  completedAt: string | null;
  payment: CheckoutSessionPayment | null;
};

/** Anything `openCheckout` and `redirectToCheckout` accept: a session, its id, or its URL. */
export type CheckoutTarget = string | { id: string; url?: string | null };

/* ── The hosted checkout's result ─────────────────────────────────────────
 *
 * What `openCheckout` resolves with. It comes from the checkout window by
 * postMessage, so it is a hint for the UI, never proof of payment: fulfil
 * from the `payment.succeeded` / `plan.opened` webhook or from
 * `checkout.sessions.retrieve` on your server.
 */

export type CheckoutCompleted = {
  status: "completed";
  sessionId: string | null;
  mode: CheckoutMode;
  orderId: string | null;
  txHash: Hex | null;
  paymentId: Hex | null;
  planId: string | null;
  subscriptionId: string | null;
};

export type CheckoutResult =
  | CheckoutCompleted
  /** The buyer pressed Cancel in the checkout. */
  | { status: "canceled"; sessionId: string | null }
  /** The buyer closed the window, or the page aborted with the `signal`. */
  | { status: "closed"; sessionId: string | null }
  /** The session expired while the checkout was open. */
  | { status: "expired"; sessionId: string | null }
  /** No result within `timeoutMs`; the window was closed. */
  | { status: "timeout"; sessionId: string | null }
  /** The page navigated to the checkout instead (mobile, or a blocked popup). The result arrives at successUrl. */
  | { status: "redirected"; sessionId: string | null };

export type CheckoutResultStatus = CheckoutResult["status"];
