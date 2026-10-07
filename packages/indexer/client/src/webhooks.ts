/**
 * The webhook dispatcher's side: page the Activity outbox by cursor and turn
 * each row into the event a merchant receives. Signing, delivery and retries
 * stay with the dispatcher (@polaris/db's webhooks); this only decides what
 * is sent and in what order.
 *
 * Each row becomes exactly the event polarispay-sdk types
 * (packages/sdk/src/events.ts, the `WebhookEvent<T>` a merchant's server
 * verifies) and the API writes for the same chain event
 * (apps/business/src/server/ingest): amounts as USD decimal strings ("25.00",
 * "201.534246"), currency "USD", mode "now" or "later", EIP-55 addresses, ISO
 * times, and the same event id, `evt_` + sha256(`<txHash>:<logIndex>:<type>`)
 * cut to 28 hex characters, so a receiver deduplicating on `id` sees one event
 * whichever path sent it. A test holds these types to a copy of the SDK's.
 *
 * What the chain doesn't know, the dispatcher passes in: the merchant's
 * public id (mer_…, looked up by the row's `merchant_id`), the checkout
 * session an order came through (looked up by the row's `orderKey`: its id,
 * your `orderId`, its metadata) and whether a payout was automatic.
 *
 * Only rows at or below the indexer's progress block are returned: Envio
 * writes a block's rows and its progress in one transaction, so a row the
 * dispatcher sees is never taken back. With the config's block_lag of 2
 * (Monad finality), a block is final before it is indexed.
 */

import { checksumAddress, sha256Hex } from "./hash.ts";
import { installmentSlice } from "./loans.ts";
import { formatAmount } from "./money.ts";
import type { Activity, CanceledBy, InstallmentFailureReason, ReasonAction, WebhookKind } from "./types.ts";

/* ── polarispay-sdk's event types (kept equal to its events.ts by test/webhooks.test.ts) ── */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type WebhookEventType = WebhookKind;

/** Fields every chain-backed event carries. */
type OnChain = {
  txHash: Hex;
  chainId: number;
};

/** Fields every event that belongs to an order carries. */
type OrderRef = {
  orderId: string;
  sessionId: string | null;
  metadata: Record<string, string>;
};

export type PaymentSucceededData = OnChain &
  OrderRef & {
    paymentId: Hex;
    mode: "now";
    merchant: Address;
    payer: Address;
    amount: string;
    fee: string;
    currency: "USD";
  };

export type PlanInstallment = { index: number; amount: string; dueAt: string };

export type PlanOpenedData = OnChain &
  OrderRef & {
    planId: string;
    mode: "later";
    merchant: Address;
    borrower: Address;
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
  remaining: string;
};

export type InstallmentFailedData = {
  planId: string;
  orderId: string;
  installment: number;
  amount: string;
  reason: InstallmentFailureReason;
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
  outstanding: string;
  recovered: string;
};

export type SubscriptionChargedData = OnChain & {
  subscriptionId: string;
  planId: string;
  merchant: Address;
  subscriber: Address;
  amount: string;
  fee: string;
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
  canceledBy: CanceledBy;
};

export type PayoutPaidData = OnChain & {
  payoutId: string;
  amount: string;
  destination: Address;
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

export type WebhookEvent<T extends WebhookEventType = WebhookEventType> = {
  [K in T]: {
    id: string;
    object: "event";
    type: K;
    /** ISO 8601: the block's time. */
    createdAt: string;
    livemode: boolean;
    merchantId: string;
    data: WebhookEventDataMap[K];
  };
}[T];

/* ── From a row ─────────────────────────────────────────────────────────── */

/** A checkout session, as the API stores it: what the chain can't know about an order. */
export type WebhookSession = {
  /** The session id (cs_…). */
  id: string;
  /** The merchant's own order id, when they gave one. */
  orderId?: string | null;
  metadata?: Record<string, string>;
};

export type WebhookContext = {
  /** The merchant's public id (mer_…), which the API keeps; the SDK refuses anything else. */
  merchantId: string;
  livemode?: boolean;
  /** Monad testnet (10143) unless given. */
  chainId?: number;
  /** The checkout session the row's order (`orderKey`) came through, if any. */
  session?: WebhookSession | null;
  /** payout.paid: whether the API paid it out automatically (its payout record). False when unknown. */
  automatic?: boolean;
};

/**
 * The key the API derives an event's id from: `<txHash>:<logIndex>:<type>`,
 * plus `:<k>` (1-based) for the k-th instalment one repayment completed.
 * (A payout's id cannot match the API's, which keys on its own payout record.)
 */
export function webhookSourceKey(a: Activity): string {
  const base = `${a.txHash}:${a.logIndex}:${a.kind}`;
  return a.kind === "installment.collected" ? `${base}:${need(a, "installmentIndex") + 1}` : base;
}

/** `evt_` + the first 28 hex characters of sha256(sourceKey): the API's eventIdFor. */
export function webhookEventId(sourceKey: string): string {
  return `evt_${sha256Hex(sourceKey).slice(0, 28)}`;
}

/** Map a skipped collection's action to polarispay-sdk's reason. */
export function failureReasonOf(action: ReasonAction | null | undefined): InstallmentFailureReason {
  if (action === "insufficient_funds" || action === "allowance_lost") return action;
  return "other";
}

export class IncompleteActivityError extends Error {
  constructor(a: Activity, field: string) {
    super(`Activity ${a.id} (${a.kind}) has no ${field}: it was written by an older indexer; re-index`);
    this.name = "IncompleteActivityError";
  }
}

function need<K extends keyof Activity>(a: Activity, field: K): NonNullable<Activity[K]> {
  const v = a[field];
  if (v === null || v === undefined) throw new IncompleteActivityError(a, String(field));
  return v as NonNullable<Activity[K]>;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export function toWebhookEvent(a: Activity, ctx: WebhookContext): WebhookEvent {
  const chainId = ctx.chainId ?? 10143;
  const session = ctx.session ?? null;
  const txHash = a.txHash as Hex;
  const merchant = checksumAddress(a.merchant_id);
  // Your order id from the session, else the one on chain (the API does the same).
  const orderId = session?.orderId ?? a.orderId ?? session?.id ?? "";
  const orderRef: OrderRef = { orderId, sessionId: session?.id ?? null, metadata: session?.metadata ?? {} };
  const envelope = {
    id: webhookEventId(webhookSourceKey(a)),
    object: "event" as const,
    createdAt: iso(a.timestamp),
    livemode: ctx.livemode ?? false,
    merchantId: ctx.merchantId,
  };

  switch (a.kind) {
    case "payment.succeeded":
      return {
        ...envelope,
        type: a.kind,
        data: {
          ...orderRef,
          paymentId: a.refId as Hex,
          mode: "now",
          merchant,
          payer: checksumAddress(need(a, "buyer")),
          amount: formatAmount(a.amount),
          fee: formatAmount(a.fee ?? 0n),
          currency: "USD",
          txHash,
          chainId,
        },
      };
    case "plan.opened": {
      const installments = need(a, "installmentCount");
      const interval = need(a, "interval");
      const firstDueAt = need(a, "firstDueAt");
      const principal = need(a, "principal");
      return {
        ...envelope,
        type: a.kind,
        data: {
          ...orderRef,
          planId: a.refId,
          mode: "later",
          merchant,
          borrower: checksumAddress(need(a, "buyer")),
          principal: formatAmount(principal),
          interest: formatAmount(a.amount - principal),
          total: formatAmount(a.amount),
          installments,
          intervalSeconds: interval,
          schedule: Array.from({ length: installments }, (_, i) => ({
            index: i + 1,
            amount: formatAmount(installmentSlice(a.amount, installments, i)),
            dueAt: iso(firstDueAt + i * interval),
          })),
          currency: "USD",
          txHash,
          chainId,
        },
      };
    }
    case "installment.collected":
      return {
        ...envelope,
        type: a.kind,
        data: {
          planId: a.refId,
          orderId,
          installment: need(a, "installmentIndex") + 1,
          installments: need(a, "installmentCount"),
          amount: formatAmount(a.amount),
          remaining: formatAmount(need(a, "remaining")),
          txHash,
          chainId,
        },
      };
    case "installment.failed": {
      const next = a.nextAttemptAt;
      return {
        ...envelope,
        type: a.kind,
        data: {
          planId: a.refId,
          orderId,
          installment: need(a, "installmentIndex") + 1,
          amount: formatAmount(a.amount),
          reason: a.failureReason ?? failureReasonOf(a.reasonAction),
          attempt: need(a, "attempt"),
          nextAttemptAt: next === null || next === undefined ? null : iso(next),
          chainId,
        },
      };
    }
    case "plan.completed":
      return { ...envelope, type: a.kind, data: { planId: a.refId, orderId, total: formatAmount(a.amount), txHash, chainId } };
    case "plan.liquidated":
      return {
        ...envelope,
        type: a.kind,
        data: { planId: a.refId, orderId, outstanding: formatAmount(a.amount), recovered: formatAmount(need(a, "recovered")), txHash, chainId },
      };
    case "subscription.charged":
      return {
        ...envelope,
        type: a.kind,
        data: {
          subscriptionId: a.refId,
          planId: need(a, "subscriptionPlanId"),
          merchant,
          subscriber: checksumAddress(need(a, "buyer")),
          amount: formatAmount(a.amount),
          fee: formatAmount(a.fee ?? 0n),
          period: need(a, "period"),
          nextChargeAt: iso(need(a, "nextChargeAt")),
          orderId: session?.orderId ?? a.orderId ?? null,
          sessionId: session?.id ?? null,
          txHash,
          chainId,
        },
      };
    case "subscription.canceled":
      return {
        ...envelope,
        type: a.kind,
        data: {
          subscriptionId: a.refId,
          planId: need(a, "subscriptionPlanId"),
          merchant,
          subscriber: checksumAddress(need(a, "buyer")),
          canceledBy: need(a, "canceledBy"),
          txHash,
          chainId,
        },
      };
    case "payout.paid":
      return {
        ...envelope,
        type: a.kind,
        data: {
          payoutId: a.refId,
          amount: formatAmount(a.amount),
          destination: checksumAddress(need(a, "destination")),
          automatic: ctx.automatic ?? false,
          txHash,
          chainId,
        },
      };
  }
}

/** Keep rows the indexer has fully committed (at or below its progress block). */
export function committed(activities: readonly Activity[], progressBlock: number | null): Activity[] {
  if (progressBlock === null) return [];
  return activities.filter((a) => a.blockNumber <= progressBlock);
}

/** The cursor to resume from after a page: the last one delivered, or the one passed in. */
export function nextCursor(after: bigint, delivered: readonly Activity[]): bigint {
  return delivered.reduce((c, a) => (a.cursor > c ? a.cursor : c), after);
}
