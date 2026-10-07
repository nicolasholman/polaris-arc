/**
 * PolarisPayments: Pay now, order quotes, subscription plans and every
 * subscription charge, miss, lapse and cancellation.
 */

import { indexer } from "envio";

import { configChange } from "../lib/config.js";
import { changeSubscription, recordPayment, settleOrder } from "../lib/domain.js";
import { withStore } from "../lib/store.js";
import { toInt } from "../lib/util.js";

indexer.onEvent({ contract: "PolarisPayments", event: "PaymentMade" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { paymentId, payer, merchant, amount, fee, orderId } = event.params;
    const { created } = await recordPayment(st, {
      id: paymentId,
      mode: "PAY_NOW",
      merchant,
      buyer: payer,
      amount,
      fee,
      orderId,
      orderKey: paymentId,
      viaCheckout: false,
    });
    if (!created) return;
    // Settled here so a direct pay() counts too; CheckoutPaid then marks it relayed.
    await settleOrder(st, { orderKey: paymentId, merchant, orderId, kind: "PAY_NOW", buyer: payer, amount, paymentId });
    st.activity("payment.succeeded", merchant, {
      buyer: payer,
      orderId,
      orderKey: paymentId,
      refId: paymentId,
      amount,
      fee,
      mode: "PAY_NOW",
    });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "OrderQuoted" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { paymentId, merchant, amount } = event.params;
    await st.merchant(merchant);
    const { row } = await st.upsert("Order", paymentId, () => ({
      id: paymentId,
      merchant_id: merchant,
      orderId: undefined,
      status: "QUOTED",
      kind: undefined,
      quotedAmount: undefined,
      quotedAt: undefined,
      amount: undefined,
      quoteMatched: undefined,
      buyer: undefined,
      payment_id: undefined,
      plan_id: undefined,
      subscription_id: undefined,
      settledAt: undefined,
      settledBlock: undefined,
      txHash: undefined,
    }));
    // A quote can be replaced until the order is paid, never after.
    if (row.status === "QUOTED") {
      row.quotedAmount = amount;
      row.quotedAt = st.m.timestamp;
    }
  }),
);

/* ── Subscription plans ─────────────────────────────────────────────────── */

indexer.onEvent({ contract: "PolarisPayments", event: "PlanCreated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { planId, merchant, price, period } = event.params;
    const m = await st.merchant(merchant);
    st.keep("SubscriptionPlan", {
      id: planId.toString(),
      planId,
      merchant_id: m.id,
      pricePerPeriod: price,
      periodSeconds: toInt(period),
      active: true,
      subscriberCount: 0,
      activeSubscriberCount: 0,
      createdAt: st.m.timestamp,
    });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "PlanDeactivated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const plan = await st.find("SubscriptionPlan", event.params.planId.toString());
    if (plan) plan.active = false;
  }),
);

/* ── Subscriptions ──────────────────────────────────────────────────────── */

indexer.onEvent({ contract: "PolarisPayments", event: "Subscribed" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { subId, planId, subscriber } = event.params;
    const plan = await st.find("SubscriptionPlan", planId.toString());
    if (!plan) {
      st.warn(`Subscribed ${subId} to unknown plan ${planId}`);
      return;
    }
    const buyer = await st.buyer(subscriber);
    const sub = st.keep("Subscription", {
      id: subId.toString(),
      subId,
      plan_id: plan.id,
      merchant_id: plan.merchant_id,
      buyer_id: buyer.id,
      orderId: undefined,
      orderKey: undefined,
      pricePerPeriod: plan.pricePerPeriod,
      periodSeconds: plan.periodSeconds,
      startedAt: st.m.timestamp,
      // PolarisPayments._subscribe: period one is charged now, the next is due one period later.
      nextChargeAt: st.m.timestamp + plan.periodSeconds,
      nextAttemptAt: st.m.timestamp + plan.periodSeconds,
      periodsCharged: 0,
      missedCharges: 0,
      status: "PENDING",
      totalCharged: 0n,
      failedAttempts: 0,
      lastFailureReason: undefined,
      lastFailureAt: undefined,
      cancelledBy: undefined,
      endedAt: undefined,
      updatedAt: st.m.timestamp,
    });
    plan.subscriberCount += 1;
    (await st.protocol()).subscriptionCount += 1;
    await changeSubscription(st, sub, () => {
      sub.status = "ACTIVE";
    });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "SubscriptionCharged" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { subId, amount, fee, period } = event.params;
    const id = subId.toString();
    const sub = await st.find("Subscription", id);
    if (!sub) {
      st.warn(`SubscriptionCharged for unknown subscription ${id}`);
      return;
    }
    const n = toInt(period);
    await recordPayment(st, {
      id: `sub-${id}-${n}`,
      mode: "SUBSCRIPTION",
      merchant: sub.merchant_id,
      buyer: sub.buyer_id,
      amount,
      fee,
      orderId: sub.orderId,
      orderKey: sub.orderKey,
      subscriptionId: id,
      period: n,
      viaCheckout: false,
    });
    sub.periodsCharged = n;
    sub.totalCharged += amount;
    sub.missedCharges = 0;
    sub.failedAttempts = 0;
    // Period one is charged at sign-up, when nextChargeAt is already a period
    // out; every later charge moves it on by one period (chargeDue).
    if (n > 1 && sub.nextChargeAt !== undefined) sub.nextChargeAt += sub.periodSeconds;
    sub.nextAttemptAt = sub.nextChargeAt;
    sub.updatedAt = st.m.timestamp;
    // The first charge comes before the checkout's SubscriptionStarted, which
    // fills in its order (checkout.ts).
    st.activity("subscription.charged", sub.merchant_id, {
      buyer: sub.buyer_id,
      orderId: sub.orderId,
      orderKey: sub.orderKey,
      refId: id,
      amount,
      fee,
      mode: "SUBSCRIPTION",
      subscriptionPlanId: sub.plan_id,
      period: n,
      nextChargeAt: sub.nextChargeAt,
    });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "ChargeMissed" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { subId, misses } = event.params;
    const sub = await st.find("Subscription", subId.toString());
    if (!sub || sub.nextChargeAt === undefined) return;
    // chargeDue past the charge window skips to the next boundary, not one period:
    // periods = (now - nextChargeAt) / period + 1.
    const periods = Math.floor((st.m.timestamp - sub.nextChargeAt) / sub.periodSeconds) + 1;
    sub.nextChargeAt += periods * sub.periodSeconds;
    sub.nextAttemptAt = sub.nextChargeAt;
    sub.missedCharges = toInt(misses);
    sub.failedAttempts = 0;
    sub.updatedAt = st.m.timestamp;
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "SubscriptionLapsed" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const sub = await st.find("Subscription", event.params.subId.toString());
    if (!sub) return;
    await changeSubscription(st, sub, () => {
      sub.status = "LAPSED";
      sub.missedCharges = toInt(event.params.misses);
      sub.endedAt = st.m.timestamp;
      sub.nextChargeAt = undefined;
      sub.nextAttemptAt = undefined;
    });
    st.activity("subscription.canceled", sub.merchant_id, {
      buyer: sub.buyer_id,
      orderId: sub.orderId,
      orderKey: sub.orderKey,
      refId: sub.id,
      amount: sub.pricePerPeriod,
      subscriptionPlanId: sub.plan_id,
      canceledBy: "lapsed",
      reason: "lapsed",
    });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "SubscriptionCancelled" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const sub = await st.find("Subscription", event.params.subId.toString());
    if (!sub) return;
    await changeSubscription(st, sub, () => {
      sub.status = "CANCELLED";
      sub.cancelledBy = event.params.by;
      sub.endedAt = st.m.timestamp;
      sub.nextChargeAt = undefined;
      sub.nextAttemptAt = undefined;
    });
    st.activity("subscription.canceled", sub.merchant_id, {
      buyer: sub.buyer_id,
      orderId: sub.orderId,
      orderKey: sub.orderKey,
      refId: sub.id,
      amount: sub.pricePerPeriod,
      subscriptionPlanId: sub.plan_id,
      // PolarisPayments lets the subscriber (directly or by signature) or the merchant cancel.
      canceledBy: event.params.by === sub.merchant_id ? "merchant" : "subscriber",
      reason: event.params.by === sub.merchant_id ? "cancelled by the merchant" : "cancelled by the buyer",
    });
  }),
);

/* ── Settings and roles ─────────────────────────────────────────────────── */

indexer.onEvent({ contract: "PolarisPayments", event: "FeeChanged" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.protocol()).feeBps = toInt(event.params.bps);
    configChange(st, "PolarisPayments", "FeeChanged", { value: event.params.bps.toString() });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "CheckoutSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisPayments", "CheckoutSet", { subject: event.params.checkout });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "OperatorSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisPayments", "OperatorSet", { subject: event.params.operator, granted: event.params.allowed });
  }),
);

indexer.onEvent({ contract: "PolarisPayments", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisPayments", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);
