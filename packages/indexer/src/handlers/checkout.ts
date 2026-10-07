/**
 * PolarisCheckout: every order a buyer settles by signature. Pay now also
 * fires PolarisPayments.PaymentMade (handled in payments.ts), Pay in 4 fires
 * the engine's LoanCreated first (loans.ts), and Subscribe fires Subscribed
 * and SubscriptionCharged first (payments.ts); these handlers add what only
 * the checkout knows: the order id, the schedule, the mode.
 */

import { indexer } from "envio";

import { changePlan, recordPayment, settleOrder } from "../lib/domain.js";
import { installmentSlice, dueAt } from "../lib/loans.js";
import { configChange } from "../lib/config.js";
import { withStore } from "../lib/store.js";
import { cursorOf, toInt } from "../lib/util.js";

indexer.onEvent({ contract: "PolarisCheckout", event: "CheckoutPaid" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { orderKey, merchant, buyer, orderId, amount } = event.params;
    const payment = await st.find("Payment", orderKey);
    if (payment) {
      payment.viaCheckout = true;
    } else {
      st.warn(`CheckoutPaid ${orderKey} without its PaymentMade`);
    }
    await settleOrder(st, { orderKey, merchant, orderId, kind: "PAY_NOW", buyer, amount, paymentId: payment?.id });
  }),
);

indexer.onEvent({ contract: "PolarisCheckout", event: "PlanOpened" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { orderKey, merchant, buyer, loanId, orderId, principal, totalOwed, installments, interval, firstDueAt } = event.params;
    const plan = await st.find("Plan", loanId.toString());
    if (!plan) {
      st.warn(`PlanOpened for loan ${loanId} without its LoanCreated`);
      return;
    }
    const count = toInt(installments);
    const intervalSeconds = toInt(interval);
    const first = toInt(firstDueAt);

    await changePlan(st, plan, () => {
      plan.orderId = orderId;
      plan.orderKey = orderKey;
      plan.interval = intervalSeconds;
      plan.firstDueAt = first;
      plan.installmentCount = count;
      plan.installmentAmount = installmentSlice(totalOwed, count, 0);
      plan.nextDueAt = dueAt(first, intervalSeconds, plan.installmentsPaid);
      plan.liquidatableAt = plan.nextDueAt + st.settings.graceSeconds + 1;
      plan.nextAttemptAt = plan.nextDueAt;
    });

    for (let i = 0; i < count; i++) {
      st.keep("Installment", {
        id: `${plan.id}-${i}`,
        plan_id: plan.id,
        index: i,
        dueAt: dueAt(first, intervalSeconds, i),
        amount: installmentSlice(totalOwed, count, i),
        paid: 0n,
        status: "PENDING",
        paidAt: undefined,
        onTime: undefined,
        paidBy: undefined,
        paidTxHash: undefined,
        failedAttempts: 0,
        lastFailureReason: undefined,
        lastFailureAt: undefined,
      });
    }

    // The merchant is paid the principal in full, now: that is the product.
    const { payment } = await recordPayment(st, {
      id: orderKey,
      mode: "PAY_IN_4",
      merchant,
      buyer,
      amount: principal,
      fee: 0n,
      orderId,
      orderKey,
      planId: plan.id,
      viaCheckout: true,
    });
    await settleOrder(st, { orderKey, merchant, orderId, kind: "PAY_IN_4", buyer, amount: principal, paymentId: payment.id, planId: plan.id });

    // polarispay-sdk announces a Pay in 4 order as plan.opened alone (no payment.succeeded).
    st.activity("plan.opened", merchant.toLowerCase(), {
      buyer: buyer.toLowerCase(),
      orderId,
      orderKey,
      refId: plan.id,
      amount: totalOwed,
      principal,
      installmentCount: count,
      interval: intervalSeconds,
      firstDueAt: first,
    });
  }),
);

indexer.onEvent({ contract: "PolarisCheckout", event: "SubscriptionStarted" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { orderKey, merchant, buyer, subId, orderId, pricePerPeriod, nextChargeAt } = event.params;
    const id = subId.toString();
    const sub = await st.find("Subscription", id);
    if (!sub) {
      st.warn(`SubscriptionStarted for subscription ${id} without its Subscribed`);
      return;
    }
    sub.orderId = orderId;
    sub.orderKey = orderKey;
    // The checkout reads it back from PolarisPayments: authoritative.
    sub.nextChargeAt = toInt(nextChargeAt);
    if (sub.failedAttempts === 0) sub.nextAttemptAt = sub.nextChargeAt;

    const first = await st.find("Payment", `sub-${id}-1`);
    if (first) {
      first.orderId = orderId;
      first.orderKey = orderKey;
      first.viaCheckout = true;
      // polarispay-sdk announces a subscription through its charges: the first
      // one's subscription.charged row (written a moment ago, by the charge
      // this checkout made) learns the order it paid.
      if (first.txHash === st.m.txHash) {
        const charged = await st.find("Activity", cursorOf(first.blockNumber, first.logIndex).toString());
        if (charged?.kind === "subscription.charged") {
          charged.orderId = orderId;
          charged.orderKey = orderKey;
        }
      }
    }
    await settleOrder(st, { orderKey, merchant, orderId, kind: "SUBSCRIPTION", buyer, amount: pricePerPeriod, paymentId: first?.id, subscriptionId: id });
  }),
);

indexer.onEvent({ contract: "PolarisCheckout", event: "Paused" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.protocol()).checkoutPaused = true;
    configChange(st, "PolarisCheckout", "Paused", { subject: event.params.account });
  }),
);

indexer.onEvent({ contract: "PolarisCheckout", event: "Unpaused" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.protocol()).checkoutPaused = false;
    configChange(st, "PolarisCheckout", "Unpaused", { subject: event.params.account });
  }),
);

indexer.onEvent({ contract: "PolarisCheckout", event: "NonceInvalidated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisCheckout", "NonceInvalidated", { subject: event.params.buyer, value: event.params.nonce.toString() });
  }),
);

// A buyer's fresh permit to the loan engine after a lost approval. The CRE
// collections workflow's log trigger collects what fell due at once; that
// collection (a Repayment) is what takes the plan out of dunning.
indexer.onEvent({ contract: "PolarisCheckout", event: "Reauthorized" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisCheckout", "Reauthorized", { subject: event.params.buyer, value: event.params.value.toString() });
  }),
);

// The GuardianReceiver asked before every new Pay in 4 plan.
indexer.onEvent({ contract: "PolarisCheckout", event: "CreditGuardianSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisCheckout", "CreditGuardianSet", { subject: event.params.guardian });
  }),
);

indexer.onEvent({ contract: "PolarisCheckout", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisCheckout", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);
