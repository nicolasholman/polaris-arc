import { describe, expect, it } from "vitest";

import { applyEvent, orderIdForEvent } from "@/lib/orders/transitions";

import { ADDR, TX, baseOrder, event } from "./helpers";

const ORDER = "hc_testorder000000000001";
const chain = { txHash: TX, chainId: 10143 };

function paid(amount = "349.00", sessionId: string | null = "cs_test_1") {
  return event("payment.succeeded", {
    ...chain,
    orderId: ORDER,
    sessionId,
    metadata: {},
    paymentId: TX,
    mode: "now",
    merchant: ADDR,
    payer: ADDR,
    amount,
    fee: "1.745",
    currency: "USD",
  });
}

function planOpened(principal = "349.00", createdAt = new Date().toISOString()) {
  const opened = new Date(createdAt).getTime();
  return event(
    "plan.opened",
    {
      ...chain,
      orderId: ORDER,
      sessionId: "cs_test_1",
      metadata: {},
      planId: "42",
      mode: "later",
      merchant: ADDR,
      borrower: ADDR,
      principal,
      interest: "0.00",
      total: principal,
      installments: 4,
      intervalSeconds: 604800,
      schedule: [1, 2, 3, 4].map((index) => ({ index, amount: "87.25", dueAt: new Date(opened + index * 604_800_000).toISOString() })),
      currency: "USD",
    },
    createdAt,
  );
}

const collected = (installment: number) =>
  event("installment.collected", { ...chain, planId: "42", orderId: ORDER, installment, installments: 4, amount: "87.25", remaining: "0.00" });

describe("order status transitions", () => {
  it("awaiting_payment → paid on a payment.succeeded that matches the order", () => {
    const r = applyEvent(baseOrder(), paid());
    expect(r.outcome).toBe("applied");
    expect(r.order.status).toBe("paid");
    expect(r.order.payment.mode).toBe("now");
    expect(r.order.payment.paidAt).toBeTruthy();
    expect(r.order.events).toHaveLength(1);
  });

  it("records a direct wallet payment (no session) as direct", () => {
    const wallet = baseOrder({ payment: { method: "wallet", sessionAttempt: 0 } });
    expect(applyEvent(wallet, paid("349.00", null)).order.payment.mode).toBe("direct");
  });

  it("→ needs_review, never paid, when the amount doesn't match", () => {
    const r = applyEvent(baseOrder(), paid("0.01"));
    expect(r.outcome).toBe("flagged");
    expect(r.order.status).toBe("needs_review");
    expect(r.order.statusReason).toMatch(/doesn't match/);
  });

  it("→ needs_review when the currency isn't USD", () => {
    const e = paid();
    (e.data as { currency: string }).currency = "EUR";
    expect(applyEvent(baseOrder(), e).order.status).toBe("needs_review");
  });

  it("reads AUSD's six decimals: 349.000000 is $349.00, 349.000001 is not", () => {
    expect(applyEvent(baseOrder(), paid("349.000000")).order.status).toBe("paid");
    expect(applyEvent(baseOrder(), paid("349.000001")).order.status).toBe("needs_review");
  });

  it("a redelivered event changes nothing", () => {
    const e = paid();
    const once = applyEvent(baseOrder(), e).order;
    const twice = applyEvent(once, e);
    expect(twice.outcome).toBe("duplicate");
    expect(twice.order).toBe(once);
    expect(twice.order.events).toHaveLength(1);
  });

  it("a paid order never goes back, even if a mismatched event follows", () => {
    const done = applyEvent(baseOrder(), paid()).order;
    const r = applyEvent(done, paid("5.00"));
    expect(r.outcome).toBe("flagged");
    expect(r.order.status).toBe("paid");
  });

  it("Pay in 4: plan.opened pays the store and records the schedule, with nothing collected at opening", () => {
    const r = applyEvent(baseOrder(), planOpened());
    expect(r.order.status).toBe("paid");
    expect(r.order.payment.mode).toBe("later");
    expect(r.order.plan?.installments.map((i) => i.amount)).toEqual([8725, 8725, 8725, 8725]);
    // PolarisLoanEngine collects nothing at checkout: every instalment waits for installment.collected.
    expect(r.order.plan?.installments.map((i) => i.status)).toEqual(["upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(r.order.plan?.status).toBe("active");
  });

  it("reads the real API's plan.opened, whose amounts carry six decimals (metropolis/api ingest.ts)", () => {
    // $200 at the loan engine's 10% APR over four weekly instalments.
    const order = baseOrder({ total: 20000, subtotal: 20000 });
    const e = planOpened("200.00");
    Object.assign(e.data, {
      interest: "1.534246",
      total: "201.534246",
      schedule: ["50.383562", "50.383561", "50.383562", "50.383561"].map((amount, i) => ({ index: i + 1, amount, dueAt: new Date(Date.now() + (i + 1) * 604_800_000).toISOString() })),
    });
    const r = applyEvent(order, e);
    expect(r.order.status).toBe("paid");
    // Never 4 x $0.00: each row is a step between rounded running totals, and they add up to the plan's total.
    const rows = r.order.plan!.installments.map((i) => i.amount);
    expect(rows).toEqual([5038, 5039, 5038, 5038]);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(20153);
    expect(r.order.plan).toMatchObject({ principal: 20000, interest: 153, total: 20153 });
    expect(r.order.events[0]!.summary).toMatch(/4 payments of \$50\.38/);
  });

  it("flags a second, different payment for an order that's already paid, for a refund", () => {
    const opened = applyEvent(baseOrder(), planOpened()).order;
    const other = paid();
    Object.assign(other.data, { paymentId: `0x${"cd".repeat(32)}`, txHash: `0x${"ef".repeat(32)}`, sessionId: "cs_test_2" });
    const r = applyEvent(opened, other);
    expect(r.outcome).toBe("flagged");
    expect(r.order.status).toBe("paid");
    expect(r.order.payment.refundDue).toBe(true);
    expect(r.order.events.at(-1)!.summary).toMatch(/second payment of \$349\.00.*Refund it/);
  });

  it("flags a charge whose kind doesn't fit the order", () => {
    const charge = event("subscription.charged", {
      ...chain,
      subscriptionId: "7",
      planId: "1",
      merchant: ADDR,
      subscriber: ADDR,
      amount: "349.00",
      fee: "1.745",
      period: 1,
      nextChargeAt: new Date().toISOString(),
      orderId: ORDER,
      sessionId: "cs_test_1",
    });
    const r = applyEvent(baseOrder(), charge);
    expect(r.outcome).toBe("flagged");
    expect(r.order.status).toBe("needs_review");
    const sub = baseOrder({ kind: "subscription" });
    expect(applyEvent(sub, planOpened()).order.status).toBe("needs_review");
  });

  it("flags a payment to an address that isn't the store's", () => {
    const r = applyEvent(baseOrder(), paid(), new Date(), { merchant: "0x1111111111111111111111111111111111111111" });
    expect(r.outcome).toBe("flagged");
    expect(r.order.status).toBe("needs_review");
    expect(applyEvent(baseOrder(), paid(), new Date(), { merchant: ADDR.toUpperCase().replace("0X", "0x") }).order.status).toBe("paid");
  });

  it("walks a Pay in 4 plan to completion", () => {
    let order = applyEvent(baseOrder(), planOpened()).order;
    for (const index of [1, 2, 3]) order = applyEvent(order, collected(index)).order;
    expect(order.plan?.installments.filter((i) => i.status === "paid")).toHaveLength(3);
    expect(order.plan?.status).toBe("active");
    order = applyEvent(order, collected(4)).order;
    expect(order.plan?.status).toBe("completed");
    order = applyEvent(order, event("plan.completed", { ...chain, planId: "42", orderId: ORDER, total: "349.00" })).order;
    expect(order.plan?.status).toBe("completed");
    expect(order.status).toBe("paid");
  });

  it("marks a missed instalment, and keeps the order paid if Polaris later liquidates the plan", () => {
    let order = applyEvent(baseOrder(), planOpened()).order;
    order = applyEvent(
      order,
      event("installment.failed", { planId: "42", orderId: ORDER, installment: 2, amount: "87.25", reason: "insufficient_funds", attempt: 1, nextAttemptAt: null, chainId: 10143 }),
    ).order;
    expect(order.plan?.status).toBe("past_due");
    expect(order.plan?.installments[1]?.status).toBe("failed");
    order = applyEvent(order, event("plan.liquidated", { ...chain, planId: "42", orderId: ORDER, outstanding: "261.75", recovered: "0.00" })).order;
    expect(order.plan?.status).toBe("liquidated");
    expect(order.status).toBe("paid");
  });

  it("asks for a retry when an instalment arrives before its plan, recording nothing", () => {
    const order = baseOrder();
    const r = applyEvent(order, collected(2));
    expect(r.outcome).toBe("retry");
    expect(r.order).toBe(order);
    expect(order.events).toHaveLength(0);
  });

  it("flags a plan whose principal doesn't match the order", () => {
    expect(applyEvent(baseOrder(), planOpened("300.00")).outcome).toBe("flagged");
  });

  it("starts a subscription on its first charge, and moves the next charge date on renewals", () => {
    const sub = baseOrder({ kind: "subscription", total: 1800, subtotal: 1800, payment: { method: "polaris", requestedMode: "subscribe", sessionAttempt: 0 } });
    const charge = (period: number, nextChargeAt: string) =>
      event("subscription.charged", {
        ...chain,
        subscriptionId: "7",
        planId: "1",
        merchant: ADDR,
        subscriber: ADDR,
        amount: "18.00",
        fee: "0.09",
        period,
        nextChargeAt,
        orderId: ORDER,
        sessionId: "cs_test_1",
      });
    const next = new Date(Date.now() + 30 * 86400_000).toISOString();
    let order = applyEvent(sub, charge(1, next)).order;
    expect(order.status).toBe("paid");
    expect(order.subscription).toMatchObject({ status: "active", periodsCharged: 1, nextChargeAt: next });
    const later = new Date(Date.now() + 60 * 86400_000).toISOString();
    order = applyEvent(order, charge(2, later)).order;
    expect(order.subscription).toMatchObject({ periodsCharged: 2, nextChargeAt: later });
    order = applyEvent(order, event("subscription.canceled", { ...chain, subscriptionId: "7", planId: "1", merchant: ADDR, subscriber: ADDR, canceledBy: "subscriber" })).order;
    expect(order.subscription?.status).toBe("canceled");
    expect(order.status).toBe("paid");
  });

  it("finds the order from the orderId the store gave Polaris, then metadata", () => {
    expect(orderIdForEvent(paid())).toBe(ORDER);
    const e = paid();
    (e.data as { orderId: string; metadata: Record<string, string> }).orderId = "";
    (e.data as { metadata: Record<string, string> }).metadata = { orderId: "hc_meta" };
    expect(orderIdForEvent(e)).toBe("hc_meta");
  });
});
