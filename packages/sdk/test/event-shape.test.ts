import { describe, expect, it } from "vitest";

import { assertWebhookEvent, validateWebhookEvent } from "../src/event-shape.js";
import { WEBHOOK_EVENT_TYPES, type WebhookEvent, type WebhookEventDataMap, type WebhookEventType } from "../src/events.js";
import { quotePayIn4 } from "../src/money.js";

const TX = "0xabababababababababababababababababababababababababababababababab";
const MERCHANT = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const ORDER = { orderId: "INV-2041", sessionId: "cs_test_a1B2c3D4e5F6g7H8", metadata: { invoice: "2041" } };
const CHAIN = { txHash: TX, chainId: 10143 } as const;

/** One well-formed event of every type, as the API sends them. Typed, so they can't drift from events.ts. */
const DATA: WebhookEventDataMap = {
  "payment.succeeded": {
    ...CHAIN,
    ...ORDER,
    paymentId: "0x3f1c2f0c6b4c6d5a3a3e8b8a1d0c9e7f5a6b4c3d2e1f0a9b8c7d6e5f4a3b2c1d",
    mode: "now",
    merchant: MERCHANT,
    payer: BUYER,
    amount: "200.00",
    fee: "1.00",
    currency: "USD",
  },
  "plan.opened": {
    ...CHAIN,
    ...ORDER,
    planId: "7",
    mode: "later",
    merchant: MERCHANT,
    borrower: BUYER,
    principal: "200.00",
    interest: "1.534246",
    total: "201.534246",
    installments: 4,
    intervalSeconds: 604_800,
    schedule: quotePayIn4("200.00").installments.map((i) => ({
      index: i.index,
      amount: `${i.amountBaseUnits / 1_000_000n}.${(i.amountBaseUnits % 1_000_000n).toString().padStart(6, "0")}`,
      dueAt: new Date(Date.UTC(2026, 9, 1, 12) + i.dueInSeconds * 1000).toISOString(),
    })),
    currency: "USD",
  },
  "installment.collected": { ...CHAIN, planId: "7", orderId: "INV-2041", installment: 1, installments: 4, amount: "50.383562", remaining: "151.150684" },
  "installment.failed": {
    planId: "7",
    orderId: "INV-2041",
    installment: 2,
    amount: "50.383561",
    reason: "insufficient_funds",
    attempt: 1,
    nextAttemptAt: "2026-10-15T18:00:00.000Z",
    chainId: 10143,
  },
  "plan.completed": { ...CHAIN, planId: "7", orderId: "INV-2041", total: "201.534246" },
  "plan.liquidated": { ...CHAIN, planId: "7", orderId: "INV-2041", outstanding: "100.767123", recovered: "100.767123" },
  "subscription.charged": {
    ...CHAIN,
    subscriptionId: "3",
    planId: "2",
    merchant: MERCHANT,
    subscriber: BUYER,
    amount: "12.00",
    fee: "0.06",
    period: 1,
    nextChargeAt: "2026-11-01T12:00:00.000Z",
    orderId: null,
    sessionId: "cs_test_sub",
  },
  "subscription.canceled": { ...CHAIN, subscriptionId: "3", planId: "2", merchant: MERCHANT, subscriber: BUYER, canceledBy: "lapsed" },
  "payout.paid": { ...CHAIN, payoutId: "po_1", amount: "311.93", destination: MERCHANT, automatic: true },
};

function envelope<T extends WebhookEventType>(type: T, data: WebhookEventDataMap[T]): WebhookEvent<T> {
  return {
    id: "evt_1a2b3c4d5e6f",
    object: "event",
    type,
    createdAt: "2026-10-01T12:00:00.000Z",
    livemode: false,
    merchantId: "mer_studio_sol",
    data,
  } as WebhookEvent<T>;
}

describe("validateWebhookEvent", () => {
  it("accepts a well-formed event of each of the nine types", () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(validateWebhookEvent(envelope(type, DATA[type])), type).toEqual([]);
    }
  });

  it("names every way the indexer's first payment.succeeded differed from the SDK's", () => {
    // What packages/indexer/client toWebhookEvent produced (security review, finding 10):
    // base units, lowercase currency, the contract's mode name, an address for
    // merchantId, and the chain fields nested under `transaction`.
    const indexed = {
      id: "evt_1790426298000000",
      object: "event",
      type: "payment.succeeded",
      createdAt: "2026-10-01T12:00:00.000Z",
      livemode: false,
      merchantId: MERCHANT,
      data: {
        id: "0x3f1c2f0c6b4c6d5a3a3e8b8a1d0c9e7f5a6b4c3d2e1f0a9b8c7d6e5f4a3b2c1d",
        orderId: "INV-2041",
        amount: "25000000",
        currency: "ausd",
        mode: "PAY_NOW",
        merchant: MERCHANT,
        transaction: { hash: TX, chainId: 10143 },
      },
    };
    const problems = validateWebhookEvent(indexed);
    const paths = problems.map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "merchantId",
        "data.amount",
        "data.currency",
        "data.mode",
        "data.paymentId",
        "data.payer",
        "data.txHash",
        "data.chainId",
        "data.sessionId",
        "data.metadata",
      ]),
    );
    expect(problems.find((p) => p.path === "data.amount")!.message).toMatch(/base units/);
  });

  it("checks each Pay in 4 schedule row, and that there is one per instalment", () => {
    const data = { ...DATA["plan.opened"], schedule: DATA["plan.opened"].schedule.slice(0, 3) };
    data.schedule[1] = { index: 2, amount: "50383561", dueAt: "next week" };
    expect(validateWebhookEvent(envelope("plan.opened", data)).map((p) => p.path)).toEqual([
      "data.schedule",
      "data.schedule[1].amount",
      "data.schedule[1].dueAt",
    ]);
  });

  it("refuses types outside the nine, and events that aren't objects", () => {
    const renewal = { ...envelope("subscription.charged", DATA["subscription.charged"]), type: "subscription.charge_failed" };
    expect(validateWebhookEvent(renewal).map((p) => p.path)).toEqual(["type"]);
    expect(validateWebhookEvent("evt")).toEqual([{ path: "", message: 'must be an event object, got "evt"' }]);
    expect(validateWebhookEvent({ ...envelope("payout.paid", DATA["payout.paid"]), data: null }).map((p) => p.path)).toEqual(["data"]);
  });

  it("allows null where the types do, and extra fields", () => {
    const event = envelope("installment.failed", { ...DATA["installment.failed"], nextAttemptAt: null });
    expect(validateWebhookEvent({ ...event, data: { ...event.data, note: "extra" }, extra: 1 })).toEqual([]);
    const bad = envelope("installment.failed", { ...DATA["installment.failed"], reason: "top_up" as never });
    expect(validateWebhookEvent(bad)).toEqual([{ path: "data.reason", message: 'must be "insufficient_funds" or "allowance_lost" or "other", got "top_up"' }]);
  });

  it("assertWebhookEvent throws with every problem listed", () => {
    expect(() => assertWebhookEvent(envelope("payment.succeeded", DATA["payment.succeeded"]))).not.toThrow();
    const bad = envelope("payment.succeeded", { ...DATA["payment.succeeded"], amount: "25000000", currency: "ausd" as never });
    expect(() => assertWebhookEvent(bad)).toThrow(/Not a well-formed payment.succeeded:\n {2}data.amount .*base units\n {2}data.currency must be "USD", got "ausd"/);
  });
});
