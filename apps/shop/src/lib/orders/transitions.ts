import type { WebhookEvent } from "polarispay-sdk";

import { formatUsd } from "@/lib/money";

import type { Order, OrderPlan, ReceivedEvent } from "./types";

/**
 * How a verified Polaris event changes an order. Pure: the webhook route
 * verifies the signature, loads the order, calls this, and saves the result.
 *
 * An order is paid when Polaris says the store has the money:
 * - payment.succeeded   Pay now, or a direct wallet payment
 * - plan.opened         Pay in 4: the store is paid the principal in full at opening
 * - subscription.charged, period 1: the first month of a subscription
 * Each must match the order (amount, currency, kind, the store's payout
 * address) or the order goes to review. A second, different payment for an
 * order that's already paid is flagged for a refund.
 *
 * - "applied":   the order changed, or the event was recorded as history.
 * - "duplicate": this event id was already applied; at-least-once delivery
 *                means repeats are normal and must change nothing.
 * - "flagged":   genuine but doesn't match the order (the wrong amount, say),
 *                so the order goes to needs_review instead of shipping.
 * - "retry":     the event arrived before the one it depends on (an
 *                instalment before its plan). Answer non-2xx so Polaris
 *                redelivers it later; nothing is recorded.
 */
export type ApplyOutcome = "applied" | "duplicate" | "flagged" | "retry";

export type ApplyResult = { outcome: ApplyOutcome; order: Order; reason?: string };

export type ApplyOptions = {
  /** The store's payout address. Payments to any other address are flagged. */
  merchant?: string | null;
};

/**
 * Webhook amounts are decimal dollars with 2 to 6 decimals (AUSD's
 * precision): "349.00", "50.383562". Parsed exactly, as micro-dollars.
 */
export function micros(amount: unknown): bigint | null {
  if (typeof amount !== "string") return null;
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Micro-dollars rounded half up to the cent, as the SDK shows them. */
function roundToCents(value: bigint): number {
  return Number((value + 5_000n) / 10_000n);
}

/** Whole cents, for amounts that must equal an order's total exactly: null if there's anything past the cent. */
function exactCents(amount: unknown): number | null {
  const value = micros(amount);
  return value !== null && value % 10_000n === 0n ? Number(value / 10_000n) : null;
}

/** Dollars for a message: "$349.00", or the amount as sent when it isn't one. */
function show(amount: unknown): string {
  const value = micros(amount);
  return value === null ? String(amount) : formatUsd(roundToCents(value));
}

function sameAddress(a: unknown, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

export function applyEvent(order: Order, event: WebhookEvent, now: Date = new Date(), options: ApplyOptions = {}): ApplyResult {
  if (order.events.some((e) => e.id === event.id)) return { outcome: "duplicate", order };

  const next: Order = structuredClone(order);
  const at = now.toISOString();
  const record = (summary: string, outcome: ReceivedEvent["outcome"] = "applied"): ApplyResult => {
    next.events.push({ id: event.id, type: event.type, createdAt: event.createdAt, receivedAt: at, summary, outcome });
    next.updatedAt = at;
    return { outcome, order: next };
  };
  const flag = (reason: string): ApplyResult => {
    if (next.status !== "paid") {
      next.status = "needs_review";
      next.statusReason = reason;
    }
    return { ...record(reason, "flagged"), reason };
  };
  /** Money arrived for an order that already has its money: the store owes it back. */
  const refund = (reason: string): ApplyResult => {
    next.payment.refundDue = true;
    next.payment.refundReason = reason;
    return flag(`${reason} Refund it.`);
  };
  const retry = (reason: string): ApplyResult => ({ outcome: "retry", order, reason });
  /** A payment that isn't the one already recorded for this paid order. */
  const another = (ref: string | null | undefined, recorded: (string | null | undefined)[]) =>
    order.status === "paid" && !!ref && !recorded.some((r) => r && r.toLowerCase() === ref.toLowerCase());

  switch (event.type) {
    case "payment.succeeded": {
      const data = event.data;
      if (options.merchant && !sameAddress(data.merchant, options.merchant)) return flag(`A payment to ${String(data.merchant)}, not this store's address.`);
      if (another(data.paymentId ?? data.txHash, [order.payment.paymentId, order.payment.txHash])) {
        return refund(`A second payment of ${show(data.amount)} arrived for an order that was already paid.`);
      }
      const amount = exactCents(data.amount);
      if (data.currency !== "USD") return flag(`Payment arrived in ${String(data.currency)}, not USD.`);
      if (amount !== order.total) {
        return flag(`Payment of ${show(data.amount)} doesn't match the order total of ${formatUsd(order.total)}.`);
      }
      // A session payment carries its session; a direct wallet payment has none.
      const direct = order.payment.method === "wallet" || !data.sessionId;
      markPaid(next, at, direct ? "direct" : "now", { payer: data.payer, txHash: data.txHash, paymentId: data.paymentId });
      return record(`${formatUsd(amount)} paid · ${direct ? "direct wallet payment" : "Pay now"}`);
    }

    case "plan.opened": {
      const data = event.data;
      if (order.kind === "subscription") return flag("A Pay in 4 plan arrived for a subscription.");
      if (options.merchant && !sameAddress(data.merchant, options.merchant)) return flag(`A plan paying ${String(data.merchant)}, not this store's address.`);
      if (another(data.planId, [order.plan?.planId])) return refund(`A second Pay in 4 plan of ${show(data.principal)} arrived for an order that was already paid.`);
      const principal = exactCents(data.principal);
      if (data.currency !== "USD") return flag(`A plan in ${String(data.currency)}, not USD.`);
      if (principal !== order.total) {
        return flag(`A plan for ${show(data.principal)} doesn't match the order total of ${formatUsd(order.total)}.`);
      }
      // Instalment amounts arrive in AUSD's six decimals ("50.383562"). Each
      // is shown as the step between two rounded running totals, so the rows
      // always add up to the plan's rounded total, as the SDK quotes them.
      const rows = [...data.schedule].sort((a, b) => a.index - b.index);
      let running = 0n;
      const installments = rows.map((inst) => {
        const before = roundToCents(running);
        running += micros(inst.amount) ?? 0n;
        // Nothing is collected at opening: PolarisLoanEngine dates instalment i
        // at startedAt + i × interval. Each is paid when installment.collected says so.
        return { index: inst.index, amount: roundToCents(running) - before, dueAt: inst.dueAt, status: "upcoming" as const, paidAt: null };
      });
      const total = micros(data.total) ?? running;
      next.plan = {
        planId: data.planId,
        intervalSeconds: data.intervalSeconds,
        status: "active",
        principal,
        interest: roundToCents(micros(data.interest) ?? total - (micros(data.principal) ?? total)),
        total: roundToCents(total),
        installments,
      };
      markPaid(next, at, "later", { payer: data.borrower, txHash: data.txHash });
      return record(
        `Pay in 4 plan opened · ${formatUsd(principal)} paid to Halcyon · ${installments.length} payments of ${formatUsd(installments[0]?.amount ?? 0)}, the first due ${new Date(installments[0]?.dueAt ?? at).toISOString().slice(0, 10)}`,
      );
    }

    case "installment.collected":
    case "installment.failed": {
      const plan = next.plan;
      if (!plan || plan.planId !== event.data.planId) return retry("The plan for this instalment hasn't arrived yet.");
      const inst = plan.installments.find((i) => i.index === event.data.installment);
      if (!inst) return retry(`Instalment ${event.data.installment} isn't on the plan.`);
      if (event.type === "installment.collected") {
        inst.status = "paid";
        inst.paidAt = event.createdAt;
        plan.status = plan.installments.every((i) => i.status === "paid") ? "completed" : "active";
        return record(`Instalment ${inst.index} of ${plan.installments.length} collected · ${formatUsd(inst.amount)}`);
      }
      inst.status = "failed";
      plan.status = "past_due";
      const why = event.data.reason === "insufficient_funds" ? "not enough in the account" : event.data.reason.replace("_", " ");
      return record(`Instalment ${inst.index} of ${plan.installments.length} missed · ${why} · attempt ${event.data.attempt}`);
    }

    case "plan.completed": {
      if (!next.plan || next.plan.planId !== event.data.planId) return retry("The plan hasn't arrived yet.");
      closePlan(next.plan, event.createdAt);
      return record("Pay in 4 plan completed");
    }

    case "plan.liquidated": {
      if (!next.plan || next.plan.planId !== event.data.planId) return retry("The plan hasn't arrived yet.");
      // The store was paid in full at checkout; a defaulted plan is Polaris's loss, not ours.
      next.plan.status = "liquidated";
      return record("Pay in 4 plan closed by Polaris after missed payments. The order stays paid.");
    }

    case "subscription.charged": {
      const data = event.data;
      if (order.kind !== "subscription") return flag("A subscription charge arrived for a one-time order.");
      if (options.merchant && !sameAddress(data.merchant, options.merchant)) return flag(`A subscription paying ${String(data.merchant)}, not this store's address.`);
      if (data.period === 1 && another(data.subscriptionId, [order.subscription?.subscriptionId])) {
        return refund(`A second subscription of ${show(data.amount)} a month started for an order that was already paid.`);
      }
      const amount = exactCents(data.amount);
      if (amount !== order.total) {
        return flag(`A subscription charge of ${show(data.amount)} doesn't match ${formatUsd(order.total)} a period.`);
      }
      next.subscription = {
        subscriptionId: data.subscriptionId,
        interval: "month",
        intervalCount: 1,
        nextChargeAt: data.nextChargeAt,
        periodsCharged: Math.max(next.subscription?.periodsCharged ?? 0, data.period),
        status: next.subscription?.status === "canceled" ? "canceled" : "active",
        canceledAt: next.subscription?.canceledAt,
      };
      if (data.period === 1) markPaid(next, at, "subscribe", { payer: data.subscriber, txHash: data.txHash });
      return record(`Subscription charged · month ${data.period} · ${formatUsd(amount)}`);
    }

    case "subscription.canceled": {
      if (!next.subscription || next.subscription.subscriptionId !== event.data.subscriptionId) {
        return retry("The subscription hasn't arrived yet.");
      }
      next.subscription.status = "canceled";
      next.subscription.canceledAt = event.createdAt;
      return record(`Subscription canceled by the ${event.data.canceledBy}`);
    }

    case "payout.paid":
      // Not about an order. The route handles merchant-level events before this.
      return record("Payout sent to the store's account");
  }
}

function markPaid(
  order: Order,
  at: string,
  mode: Order["payment"]["mode"],
  details: { payer?: string; txHash?: string; paymentId?: string },
) {
  if (order.status === "paid") return;
  order.status = "paid";
  delete order.statusReason;
  order.payment.paidAt = at;
  order.payment.mode = mode;
  if (details.payer) order.payment.payer = details.payer;
  if (details.txHash) order.payment.txHash = details.txHash;
  if (details.paymentId) order.payment.paymentId = details.paymentId;
}

function closePlan(plan: OrderPlan, at: string) {
  plan.status = "completed";
  for (const inst of plan.installments) {
    if (inst.status !== "paid") {
      inst.status = "paid";
      inst.paidAt = at;
    }
  }
}

/** Events about an order, as opposed to the merchant's account (payouts). */
export function isOrderEvent(event: WebhookEvent): boolean {
  return event.type !== "payout.paid";
}

/** The order an event is about: the orderId the shop gave the session or pay() (its payRef), then metadata. */
export function orderIdForEvent(event: WebhookEvent): string | null {
  const data = event.data as { orderId?: unknown; metadata?: Record<string, unknown> };
  if (typeof data.orderId === "string" && data.orderId) return data.orderId;
  const fromMetadata = data.metadata?.orderId;
  return typeof fromMetadata === "string" && fromMetadata ? fromMetadata : null;
}
