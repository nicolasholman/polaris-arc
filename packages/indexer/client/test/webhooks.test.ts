/**
 * Every Activity row becomes exactly the event polarispay-sdk defines and the
 * API sends: held to a copy of the SDK's types (at compile time, `pnpm
 * typecheck`) and its runtime check (validateWebhookEvent), with the API's
 * amounts, addresses and event ids.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  committed,
  IncompleteActivityError,
  nextCursor,
  toWebhookEvent,
  webhookSourceKey,
  type Activity,
  type WebhookEvent,
  type WebhookEventDataMap,
  type WebhookEventType,
  type WebhookKind,
} from "../src/index.js";
import { validateWebhookEvent } from "../src/sdk-event-shape.js";
import type { WebhookEvent as SdkWebhookEvent, WebhookEventDataMap as SdkDataMap, WebhookEventType as SdkEventType } from "../src/sdk-events.js";

/* ── The client's types are the SDK's (checked by `pnpm typecheck`) ─────── */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameTypes: { [K in SdkEventType]: Same<SdkDataMap[K], WebhookEventDataMap[K]> } & { all: Same<SdkEventType, WebhookEventType> } = {
  "payment.succeeded": true,
  "plan.opened": true,
  "installment.collected": true,
  "installment.failed": true,
  "plan.completed": true,
  "plan.liquidated": true,
  "subscription.charged": true,
  "subscription.canceled": true,
  "payout.paid": true,
  all: true,
};
const asSdk = (e: WebhookEvent): SdkWebhookEvent => e;

/* ── Rows as the indexer writes them ────────────────────────────────────── */

const MERCHANT = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const BUYER = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
const TX = `0x${"ab".repeat(32)}`;
const ORDER_KEY = `0x${"c3".repeat(32)}`;
const T = 1_790_000_000;
const ctx = { merchantId: "mer_2x8Kq" };

function row(kind: WebhookKind, fields: Partial<Activity>, logIndex = 4, slot = 0): Activity {
  const cursor = 1_200n * 100_000_000n + BigInt(logIndex) * 100n + BigInt(slot);
  return {
    id: cursor.toString(),
    cursor,
    kind,
    merchant_id: MERCHANT,
    buyer: BUYER,
    orderId: "order-42",
    orderKey: ORDER_KEY,
    mode: null,
    amount: 0n,
    fee: null,
    refId: "1",
    installmentIndex: null,
    installmentCount: null,
    principal: null,
    interval: null,
    firstDueAt: null,
    remaining: null,
    recovered: null,
    attempt: null,
    nextAttemptAt: null,
    failureReason: null,
    subscriptionPlanId: null,
    period: null,
    nextChargeAt: null,
    canceledBy: null,
    reason: null,
    reasonAction: null,
    destination: null,
    timestamp: T,
    blockNumber: 1_200,
    logIndex,
    txHash: TX,
    ...fields,
  };
}

const WEEK = 604_800;
const OWED = 201_534_246n;
const rows: Record<WebhookKind, Activity> = {
  "payment.succeeded": row("payment.succeeded", { refId: ORDER_KEY, mode: "PAY_NOW", amount: 25_000_000n, fee: 125_000n }),
  "plan.opened": row("plan.opened", { amount: OWED, principal: 200_000_000n, installmentCount: 4, interval: WEEK, firstDueAt: T + WEEK }),
  "installment.collected": row("installment.collected", { amount: 50_383_562n, installmentIndex: 0, installmentCount: 4, remaining: OWED - 50_383_562n }),
  "installment.failed": row("installment.failed", {
    amount: 50_383_561n,
    installmentIndex: 1,
    installmentCount: 4,
    attempt: 2,
    nextAttemptAt: T + 86_400,
    failureReason: "allowance_lost",
    reason: "InsufficientAllowance",
    reasonAction: "allowance_lost",
  }),
  "plan.completed": row("plan.completed", { amount: OWED }),
  "plan.liquidated": row("plan.liquidated", { amount: 100_000_076n, recovered: 20_000_000n, reason: "recovered 20000000 of 100000076" }),
  "subscription.charged": row("subscription.charged", {
    refId: "2",
    mode: "SUBSCRIPTION",
    amount: 9_990_000n,
    fee: 49_950n,
    subscriptionPlanId: "1",
    period: 3,
    nextChargeAt: T + 2_592_000,
  }),
  "subscription.canceled": row("subscription.canceled", { refId: "2", amount: 9_990_000n, subscriptionPlanId: "1", canceledBy: "merchant", reason: "cancelled by the merchant" }),
  "payout.paid": row("payout.paid", { refId: `${TX}-4`, buyer: null, orderId: null, orderKey: null, amount: 30_000_000n, destination: "0xde709f2102306220921060314715629080e2fb77" }),
};

/** The API's eventIdFor(`<txHash>:<logIndex>:<type>[...]`), with Node's own SHA-256. */
const apiEventId = (sourceKey: string) => `evt_${createHash("sha256").update(sourceKey).digest("hex").slice(0, 28)}`;

describe("webhook events", () => {
  it("has the SDK's types", () => {
    assert.ok(Object.values(sameTypes).every(Boolean));
  });

  for (const [kind, activity] of Object.entries(rows) as Array<[WebhookKind, Activity]>) {
    it(`${kind} passes polarispay-sdk's own check`, () => {
      const event = asSdk(toWebhookEvent(activity, ctx));
      assert.deepEqual(validateWebhookEvent(event), []);
      assert.equal(event.type, kind);
      assert.equal(event.merchantId, "mer_2x8Kq");
      assert.equal(event.createdAt, "2026-09-21T14:13:20.000Z");
      assert.equal(event.livemode, false);
      // What goes on the wire has no bigint in it.
      assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
    });
  }

  it("carries a Pay now payment in dollars, USD and the SDK's mode, with checksummed addresses", () => {
    const event = toWebhookEvent(rows["payment.succeeded"], ctx);
    assert.deepEqual(event.data, {
      orderId: "order-42",
      sessionId: null,
      metadata: {},
      paymentId: ORDER_KEY,
      mode: "now",
      merchant: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      payer: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      amount: "25.00",
      fee: "0.125",
      currency: "USD",
      txHash: TX,
      chainId: 10143,
    });
  });

  it("names the checkout session, your order id and metadata when the API passes them", () => {
    const session = { id: "cs_9", orderId: "INV-7", metadata: { cart: "3" } };
    const paid = toWebhookEvent(rows["payment.succeeded"], { ...ctx, session, chainId: 143, livemode: true });
    assert.ok(paid.type === "payment.succeeded");
    assert.equal(paid.livemode, true);
    assert.deepEqual([paid.data.orderId, paid.data.sessionId, paid.data.metadata, paid.data.chainId], ["INV-7", "cs_9", { cart: "3" }, 143]);
    const charged = toWebhookEvent(rows["subscription.charged"], { ...ctx, session });
    assert.ok(charged.type === "subscription.charged");
    assert.deepEqual([charged.data.orderId, charged.data.sessionId], ["INV-7", "cs_9"]);
  });

  it("gives a Pay in 4 plan its schedule on the engine's ladder", () => {
    const event = toWebhookEvent(rows["plan.opened"], ctx);
    assert.ok(event.type === "plan.opened");
    assert.deepEqual(
      { ...event.data, schedule: undefined },
      {
        orderId: "order-42",
        sessionId: null,
        metadata: {},
        planId: "1",
        mode: "later",
        merchant: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
        borrower: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
        principal: "200.00",
        interest: "1.534246",
        total: "201.534246",
        installments: 4,
        intervalSeconds: WEEK,
        schedule: undefined,
        currency: "USD",
        txHash: TX,
        chainId: 10143,
      },
    );
    // The first instalment falls due one interval after opening, as the engine has it.
    assert.deepEqual(event.data.schedule, [
      { index: 1, amount: "50.383562", dueAt: "2026-09-28T14:13:20.000Z" },
      { index: 2, amount: "50.383561", dueAt: "2026-10-05T14:13:20.000Z" },
      { index: 3, amount: "50.383562", dueAt: "2026-10-12T14:13:20.000Z" },
      { index: 4, amount: "50.383561", dueAt: "2026-10-19T14:13:20.000Z" },
    ]);
  });

  it("numbers instalments from 1 and says what is still owed", () => {
    const collected = toWebhookEvent(rows["installment.collected"], ctx);
    assert.deepEqual(collected.data, {
      planId: "1",
      orderId: "order-42",
      installment: 1,
      installments: 4,
      amount: "50.383562",
      remaining: "151.150684",
      txHash: TX,
      chainId: 10143,
    });
    const failed = toWebhookEvent(rows["installment.failed"], ctx);
    assert.deepEqual(failed.data, {
      planId: "1",
      orderId: "order-42",
      installment: 2,
      amount: "50.383561",
      reason: "allowance_lost",
      attempt: 2,
      nextAttemptAt: "2026-09-22T14:13:20.000Z",
      chainId: 10143,
    });
    // No next attempt: liquidation is next.
    const last = toWebhookEvent({ ...rows["installment.failed"], nextAttemptAt: null }, ctx);
    assert.ok(last.type === "installment.failed");
    assert.equal(last.data.nextAttemptAt, null);
    // A row without the SDK's word for the reason gets it from the action.
    const older = toWebhookEvent({ ...rows["installment.failed"], failureReason: null, reasonAction: "insufficient_funds" }, ctx);
    assert.ok(older.type === "installment.failed");
    assert.equal(older.data.reason, "insufficient_funds");
  });

  it("closes plans, charges and ends subscriptions, and pays out, in the SDK's fields", () => {
    assert.deepEqual(toWebhookEvent(rows["plan.completed"], ctx).data, { planId: "1", orderId: "order-42", total: "201.534246", txHash: TX, chainId: 10143 });
    assert.deepEqual(toWebhookEvent(rows["plan.liquidated"], ctx).data, {
      planId: "1",
      orderId: "order-42",
      outstanding: "100.000076",
      recovered: "20.00",
      txHash: TX,
      chainId: 10143,
    });
    assert.deepEqual(toWebhookEvent(rows["subscription.charged"], ctx).data, {
      subscriptionId: "2",
      planId: "1",
      merchant: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      subscriber: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      amount: "9.99",
      fee: "0.04995",
      period: 3,
      nextChargeAt: "2026-10-21T14:13:20.000Z",
      orderId: "order-42",
      sessionId: null,
      txHash: TX,
      chainId: 10143,
    });
    assert.deepEqual(toWebhookEvent(rows["subscription.canceled"], ctx).data, {
      subscriptionId: "2",
      planId: "1",
      merchant: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      subscriber: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      canceledBy: "merchant",
      txHash: TX,
      chainId: 10143,
    });
    assert.deepEqual(toWebhookEvent(rows["payout.paid"], { ...ctx, automatic: true }).data, {
      payoutId: `${TX}-4`,
      amount: "30.00",
      destination: "0xde709f2102306220921060314715629080e2fb77",
      automatic: true,
      txHash: TX,
      chainId: 10143,
    });
  });

  it("uses the API's event id for the same chain event, so a receiver deduplicates across both", () => {
    for (const kind of Object.keys(rows) as WebhookKind[]) {
      if (kind === "installment.collected") continue;
      assert.equal(toWebhookEvent(rows[kind], ctx).id, apiEventId(`${TX}:4:${kind}`), kind);
    }
    // One repayment completing instalments 2 and 3 is two events, keyed 2 and 3 as the API keys them.
    const second = { ...rows["installment.collected"], installmentIndex: 1 };
    const third = { ...rows["installment.collected"], installmentIndex: 2, id: "x", cursor: second.cursor + 1n };
    assert.equal(webhookSourceKey(second), `${TX}:4:installment.collected:2`);
    assert.equal(toWebhookEvent(second, ctx).id, apiEventId(`${TX}:4:installment.collected:2`));
    assert.equal(toWebhookEvent(third, ctx).id, apiEventId(`${TX}:4:installment.collected:3`));
  });

  it("refuses a row an older indexer wrote without the fields an event needs", () => {
    assert.throws(() => toWebhookEvent({ ...rows["plan.opened"], installmentCount: null }, ctx), IncompleteActivityError);
    assert.throws(() => toWebhookEvent({ ...rows["subscription.charged"], period: null }, ctx), /has no period/);
  });

  it("delivers only committed rows and resumes after the last one", () => {
    const base = rows["payment.succeeded"];
    const later = { ...base, cursor: base.cursor + 100_000_000n, blockNumber: 1_201 };
    assert.deepEqual(committed([base, later], 1_200), [base]);
    assert.deepEqual(committed([base], null), []);
    assert.equal(nextCursor(0n, [base, later]), later.cursor);
    assert.equal(nextCursor(99n, []), 99n);
  });
});
