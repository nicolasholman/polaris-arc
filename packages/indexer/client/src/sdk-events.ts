/**
 * polarispay-sdk's webhook event types and type list (packages/sdk/src/events.ts),
 * verbatim, with its one import (three type aliases) inlined. The dispatcher
 * in Polaris for Business runs the SDK's validateWebhookEvent
 * (./sdk-event-shape.ts) on every event it builds from the outbox; this
 * package ships TypeScript source that Next.js already transpiles, the SDK
 * ships only a build. test/sdk-copy.test.ts fails if either copy drifts from
 * the SDK's source.
 */

type Address = `0x${string}`;
type Hex = `0x${string}`;
type CheckoutMode = "now" | "later" | "subscribe";

/**
 * Webhook events, exactly the nine plan §5.8 lists. Every event is built
 * from an indexed chain event (Envio), never from a client, so "paid" in a
 * webhook means paid on Monad.
 *
 * Amounts are USD decimal strings with 2 to 6 decimals (AUSD's precision):
 * "200.00", "1.00005", never base units. `validateWebhookEvent` checks an
 * event against these types at runtime.
 */

export const WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "plan.opened",
  "installment.collected",
  "installment.failed",
  "plan.completed",
  "plan.liquidated",
  "subscription.charged",
  "subscription.canceled",
  "payout.paid",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(value);
}

/** Fields every chain-backed event carries. */
type OnChain = {
  /** The transaction the event came from. */
  txHash: Hex;
  chainId: number;
};

/** Fields every event that belongs to an order carries. */
type OrderRef = {
  /** Your `orderId` from the checkout session or `pay()`, else the session id. */
  orderId: string;
  /** The checkout session, when the payment came through one. */
  sessionId: string | null;
  /** The session's metadata, echoed. */
  metadata: Record<string, string>;
};

export type PaymentSucceededData = OnChain &
  OrderRef & {
    /** PolarisPayments payment id: keccak256(abi.encodePacked(merchant, orderId)). */
    paymentId: Hex;
    mode: Extract<CheckoutMode, "now">;
    merchant: Address;
    payer: Address;
    amount: string;
    /** Protocol fee kept from `amount` (0.5%). The merchant receives amount − fee. */
    fee: string;
    currency: "USD";
  };

export type PlanInstallment = { index: number; amount: string; dueAt: string };

export type PlanOpenedData = OnChain &
  OrderRef & {
    /** PolarisLoanEngine loan id. */
    planId: string;
    mode: Extract<CheckoutMode, "later">;
    merchant: Address;
    borrower: Address;
    /** What the merchant was paid, in full, at opening. */
    principal: string;
    interest: string;
    total: string;
    installments: number;
    intervalSeconds: number;
    schedule: PlanInstallment[];
    currency: "USD";
  };

export type InstallmentCollectedData = OnChain & {
  planId: string;
  orderId: string;
  /** 1-based. */
  installment: number;
  installments: number;
  amount: string;
  /** Still owed after this collection. */
  remaining: string;
};

/** Why a collection was skipped, from the CRE collections workflow. */
export type InstallmentFailureReason = "insufficient_funds" | "allowance_lost" | "other";

export type InstallmentFailedData = {
  planId: string;
  orderId: string;
  installment: number;
  amount: string;
  reason: InstallmentFailureReason;
  /** 1 for the first miss; the dunning ladder retries at 6h, 24h, 72h, then 168h. */
  attempt: number;
  /** ISO 8601, or null when the next step is liquidation. */
  nextAttemptAt: string | null;
  chainId: number;
};

export type PlanCompletedData = OnChain & {
  planId: string;
  orderId: string;
  total: string;
};

export type PlanLiquidatedData = OnChain & {
  planId: string;
  orderId: string;
  /** Owed when the plan was liquidated. */
  outstanding: string;
  /** Recovered from the buyer's collateral and allowance. */
  recovered: string;
};

export type SubscriptionChargedData = OnChain & {
  /** PolarisPayments subscription id. */
  subscriptionId: string;
  /** PolarisPayments plan id. */
  planId: string;
  merchant: Address;
  subscriber: Address;
  amount: string;
  fee: string;
  /** 1 for the first charge. */
  period: number;
  nextChargeAt: string;
  orderId: string | null;
  sessionId: string | null;
};

export type SubscriptionCanceledData = OnChain & {
  subscriptionId: string;
  planId: string;
  merchant: Address;
  subscriber: Address;
  canceledBy: "subscriber" | "merchant" | "lapsed";
};

export type PayoutPaidData = OnChain & {
  payoutId: string;
  amount: string;
  /** Where it went: the merchant's payout address or an exchange deposit address. */
  destination: Address;
  /** True for an automatic daily payout (Privy session signer), false for a manual one. */
  automatic: boolean;
};

export type WebhookEventDataMap = {
  "payment.succeeded": PaymentSucceededData;
  "plan.opened": PlanOpenedData;
  "installment.collected": InstallmentCollectedData;
  "installment.failed": InstallmentFailedData;
  "plan.completed": PlanCompletedData;
  "plan.liquidated": PlanLiquidatedData;
  "subscription.charged": SubscriptionChargedData;
  "subscription.canceled": SubscriptionCanceledData;
  "payout.paid": PayoutPaidData;
};

/**
 * The envelope, as delivered:
 *
 *   { "id": "evt_…", "object": "event", "type": "payment.succeeded",
 *     "createdAt": "2026-10-01T12:00:00.000Z", "livemode": false,
 *     "merchantId": "mer_…", "data": { … } }
 *
 * Delivery is at least once: key on `id` and treat a repeat as a no-op.
 */
export type WebhookEvent<T extends WebhookEventType = WebhookEventType> = {
  [K in T]: {
    id: string;
    object: "event";
    type: K;
    /** ISO 8601. */
    createdAt: string;
    livemode: boolean;
    merchantId: string;
    data: WebhookEventDataMap[K];
  };
}[T];
