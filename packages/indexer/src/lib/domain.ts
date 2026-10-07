/**
 * The bookkeeping several handlers share: recording a payment to a merchant,
 * and keeping merchant, buyer and protocol totals exact as plans and
 * subscriptions change state.
 *
 * Totals are kept by contribution: before a plan changes we note what it
 * contributed (open, outstanding, at risk), after it changes we add the
 * difference. A plan can then move through any sequence of states and the
 * totals stay equal to a recount.
 */

import { balanceTick, candle, type Buyer, type Merchant, type Payment, type Plan, type Store, type Subscription } from "./store.js";
import { monthlyValue, type PaymentMode } from "./util.js";

/* ── Plans ──────────────────────────────────────────────────────────────── */

type PlanShare = { active: number; outstanding: bigint; dunning: number; atRisk: bigint };

function planShare(plan: Plan): PlanShare {
  const active = plan.status === "ACTIVE";
  const dunning = active && plan.dunning;
  return {
    active: active ? 1 : 0,
    outstanding: active ? plan.outstanding : 0n,
    dunning: dunning ? 1 : 0,
    atRisk: dunning ? plan.outstanding : 0n,
  };
}

/**
 * Change a plan and carry the change into its merchant's, its buyer's and the
 * protocol's totals. `mutate` may change status, outstanding and dunning.
 */
export async function changePlan(st: Store, plan: Plan, mutate: () => void | Promise<void>): Promise<void> {
  const before = planShare(plan);
  await mutate();
  const after = planShare(plan);
  plan.updatedAt = st.m.timestamp;

  const merchant = await st.merchant(plan.merchant_id);
  merchant.activePlanCount += after.active - before.active;
  merchant.outstanding += after.outstanding - before.outstanding;
  merchant.dunningPlanCount += after.dunning - before.dunning;
  merchant.atRiskOutstanding += after.atRisk - before.atRisk;

  const buyer = await st.buyer(plan.buyer_id);
  buyer.activePlanCount += after.active - before.active;
  buyer.activeDebt += after.outstanding - before.outstanding;
  await st.refreshCredit(buyer);

  const p = await st.protocol();
  p.activePlanCount += after.active - before.active;
  p.outstanding += after.outstanding - before.outstanding;
}

/* ── Subscriptions ──────────────────────────────────────────────────────── */

type SubShare = { active: number; mrr: bigint };

function subShare(sub: Subscription): SubShare {
  const active = sub.status === "ACTIVE";
  return { active: active ? 1 : 0, mrr: active ? monthlyValue(sub.pricePerPeriod, sub.periodSeconds) : 0n };
}

export async function changeSubscription(st: Store, sub: Subscription, mutate: () => void | Promise<void>): Promise<void> {
  const before = subShare(sub);
  await mutate();
  const after = subShare(sub);
  sub.updatedAt = st.m.timestamp;

  const merchant = await st.merchant(sub.merchant_id);
  merchant.activeSubscriptionCount += after.active - before.active;
  merchant.mrr += after.mrr - before.mrr;

  const buyer = await st.buyer(sub.buyer_id);
  buyer.activeSubscriptionCount += after.active - before.active;

  const plan = await st.find("SubscriptionPlan", sub.plan_id);
  if (plan) {
    plan.activeSubscriberCount += after.active - before.active;
    st.keep("SubscriptionPlan", plan);
  }

  const p = await st.protocol();
  p.activeSubscriptionCount += after.active - before.active;
}

/* ── Payments ───────────────────────────────────────────────────────────── */

export type PaymentInput = {
  readonly id: string;
  readonly mode: PaymentMode;
  readonly merchant: string;
  readonly buyer: string;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly orderId?: string;
  readonly orderKey?: string;
  readonly planId?: string;
  readonly subscriptionId?: string;
  readonly period?: number;
  readonly viaCheckout: boolean;
};

/**
 * Record money a merchant was paid: the Payment row and every total and
 * daily figure it moves. Idempotent on the payment id, so a second event
 * about the same payment (CheckoutPaid after PaymentMade) never counts twice.
 */
export async function recordPayment(st: Store, input: PaymentInput): Promise<{ payment: Payment; merchant: Merchant; buyer: Buyer; created: boolean }> {
  const merchant = await st.merchant(input.merchant);
  const buyer = await st.buyer(input.buyer);
  const existing = await st.find("Payment", input.id);
  if (existing) return { payment: existing, merchant, buyer, created: false };

  const m = st.m;
  const net = input.amount - input.fee;
  const payment = st.keep("Payment", {
    id: input.id,
    merchant_id: merchant.id,
    buyer_id: buyer.id,
    mode: input.mode,
    amount: input.amount,
    fee: input.fee,
    net,
    orderId: input.orderId,
    orderKey: input.orderKey,
    quotedAmount: undefined as bigint | undefined,
    plan_id: input.planId,
    subscription_id: input.subscriptionId,
    period: input.period,
    viaCheckout: input.viaCheckout,
    relayer: m.from,
    day: m.day,
    timestamp: m.timestamp,
    blockNumber: m.blockNumber,
    logIndex: m.logIndex,
    txHash: m.txHash,
  } satisfies Payment);

  merchant.paymentCount += 1;
  merchant.grossVolume += input.amount;
  merchant.feeVolume += input.fee;
  merchant.netVolume += net;
  merchant.lastPaymentAt = m.timestamp;
  if (input.mode === "PAY_NOW") {
    merchant.payNowCount += 1;
    merchant.payNowVolume += input.amount;
  } else if (input.mode === "SUBSCRIPTION") {
    merchant.subscriptionChargeCount += 1;
    merchant.subscriptionVolume += input.amount;
  }
  // Pay in 4 plan counts move with the loan itself (LoanCreated).

  buyer.paymentCount += 1;
  buyer.spent += input.amount;
  const buyerDay = await st.buyerDay(buyer);
  buyerDay.spent += input.amount;

  const firstTime = await st.customer(merchant, buyer, input.amount);

  const day = await st.merchantDay(merchant);
  day.paymentCount += 1;
  day.grossVolume += input.amount;
  day.feeVolume += input.fee;
  day.netVolume += net;
  if (input.mode === "PAY_NOW") {
    day.payNowCount += 1;
    day.payNowVolume += input.amount;
  } else if (input.mode === "PAY_IN_4") {
    day.planCount += 1;
    day.planVolume += input.amount;
  } else {
    day.subscriptionChargeCount += 1;
    day.subscriptionVolume += input.amount;
  }
  if (firstTime) day.newCustomers += 1;
  candle(day, input.amount);
  balanceTick(day, merchant.balance);

  const p = await st.protocol();
  p.paymentCount += 1;
  p.grossVolume += input.amount;
  p.feeVolume += input.fee;
  if (input.mode === "PAY_NOW") {
    p.payNowCount += 1;
    p.payNowVolume += input.amount;
  } else if (input.mode === "SUBSCRIPTION") {
    p.subscriptionVolume += input.amount;
  }
  const pd = await st.protocolDay();
  pd.paymentCount += 1;
  pd.grossVolume += input.amount;
  pd.feeVolume += input.fee;
  if (input.mode === "SUBSCRIPTION") {
    pd.subscriptionCharges += 1;
    pd.subscriptionVolume += input.amount;
  }
  candle(pd, input.amount);

  return { payment, merchant, buyer, created: true };
}

/**
 * Mark an order key settled. An order settles once, in one mode; its quote
 * (if any) is checked against what was paid.
 */
export async function settleOrder(
  st: Store,
  args: {
    orderKey: string;
    merchant: string;
    orderId: string;
    kind: PaymentMode;
    buyer: string;
    amount: bigint;
    paymentId?: string;
    planId?: string;
    subscriptionId?: string;
  },
): Promise<void> {
  const { row: order } = await st.upsert("Order", args.orderKey, () => ({
    id: args.orderKey,
    merchant_id: args.merchant.toLowerCase(),
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
  order.orderId = args.orderId;
  order.status = "PAID";
  order.kind = args.kind;
  order.amount = args.amount;
  order.buyer = args.buyer.toLowerCase();
  order.quoteMatched = order.quotedAmount === undefined ? undefined : order.quotedAmount === args.amount;
  order.payment_id = args.paymentId ?? order.payment_id;
  order.plan_id = args.planId ?? order.plan_id;
  order.subscription_id = args.subscriptionId ?? order.subscription_id;
  order.settledAt = st.m.timestamp;
  order.settledBlock = st.m.blockNumber;
  order.txHash = st.m.txHash;
  if (args.paymentId) {
    const payment = await st.find("Payment", args.paymentId);
    if (payment && order.quotedAmount !== undefined) payment.quotedAmount = order.quotedAmount;
  }
}
