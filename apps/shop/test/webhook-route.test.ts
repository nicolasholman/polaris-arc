import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/webhooks/polaris/route";
import { createMemoryStore, orderStore, setOrderStore } from "@/lib/orders/store";
import { createOrder } from "@/lib/orders/service";
import type { WebhookEvent } from "polarispay-sdk";

import { ADDR, SECRET, TX, event, priced, signed } from "./helpers";

function deliver(e: WebhookEvent | string, header?: string | null) {
  const body = typeof e === "string" ? e : JSON.stringify(e);
  return POST(
    new Request("https://shop.test/api/webhooks/polaris", {
      method: "POST",
      headers: { "content-type": "application/json", ...(header === null ? {} : { "polaris-signature": header ?? signed(body) }) },
      body,
    }),
  );
}

let orderId = "";
/** What the shop gave Polaris as the session's orderId, and what webhooks name the order by. */
let payRef = "";
let cookie = "";

beforeEach(async () => {
  setOrderStore(createMemoryStore());
  vi.stubEnv("POLARIS_API_BASE", "https://api.polaris.test");
  vi.stubEnv("POLARIS_SECRET_KEY", "sk_test_shopsecret123");
  vi.stubEnv("POLARIS_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY", "pk_test_shoppublic123");
  vi.stubEnv("NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN", "https://pay.polaris.test");
  vi.stubEnv("POLARIS_MERCHANT_ADDRESS", "0x1111111111111111111111111111111111111111");
  const created = await createOrder(priced(), "hc_webhook_test");
  if (!created.ok) throw new Error("no order");
  orderId = created.order.id;
  payRef = created.order.payRef!;
  cookie = `hc_o_${orderId}=${created.order.accessToken}`;
});

afterEach(() => vi.unstubAllEnvs());

const MERCHANT = "0x1111111111111111111111111111111111111111" as const;

const paidEvent = (overrides: { orderId?: string; sessionId?: string | null; amount?: string } = {}) =>
  event("payment.succeeded", {
    txHash: TX,
    chainId: 10143,
    orderId: overrides.orderId ?? payRef,
    sessionId: overrides.sessionId === undefined ? "cs_test_1" : overrides.sessionId,
    metadata: {},
    paymentId: TX,
    mode: "now",
    merchant: MERCHANT,
    payer: ADDR,
    amount: overrides.amount ?? "349.00",
    fee: "1.745",
    currency: "USD",
  });
const paid = () => paidEvent();

async function status() {
  return (await orderStore().read()).orders[orderId]!.status;
}

describe("POST /api/webhooks/polaris", () => {
  it("a valid, signed payment.succeeded marks the order paid", async () => {
    const res = await deliver(paid());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, outcome: "applied" });
    expect(await status()).toBe("paid");
  });

  it("a tampered body is rejected and changes nothing", async () => {
    const e = paid();
    const body = JSON.stringify(e);
    const header = signed(body);
    // Someone replays a real delivery for another order id, keeping the signature.
    const res = await deliver(body.replaceAll(payRef, "hcp_someone_elses_order"), header);
    expect(res.status).toBe(400);
    expect(await status()).toBe("awaiting_payment");
  });

  it("an unsigned delivery is rejected", async () => {
    expect((await deliver(paid(), null)).status).toBe(400);
    expect(await status()).toBe("awaiting_payment");
  });

  it("a stale delivery (a captured request replayed later) is rejected", async () => {
    const body = JSON.stringify(paid());
    const res = await deliver(body, signed(body, SECRET, Math.floor(Date.now() / 1000) - 600));
    expect(res.status).toBe(400);
    expect(await status()).toBe("awaiting_payment");
  });

  it("a redelivered event, freshly signed, is acknowledged once and applied once", async () => {
    const e = paid();
    expect(await (await deliver(e)).json()).toMatchObject({ outcome: "applied" });
    const again = await deliver(e);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: "duplicate" });
    const order = (await orderStore().read()).orders[orderId]!;
    expect(order.events).toHaveLength(1);
  });

  it("answers 409 to an instalment that beats its plan, so Polaris redelivers it", async () => {
    const res = await deliver(
      event("installment.collected", { txHash: TX, chainId: 10143, planId: "42", orderId: payRef, installment: 2, installments: 4, amount: "87.25", remaining: "174.50" }),
    );
    expect(res.status).toBe(409);
    const data = await orderStore().read();
    expect(Object.keys(data.events)).toHaveLength(0);
  });

  it("finds the order by its id, for orders placed before payRef existed", async () => {
    expect((await deliver(paidEvent({ orderId }))).status).toBe(200);
    expect(await status()).toBe("paid");
  });

  it("finds the order by session id when metadata is missing", async () => {
    await orderStore().update((d) => {
      d.orders[orderId]!.payment.sessionId = "cs_by_session";
    });
    const e = paidEvent({ orderId: "cs_by_session", sessionId: "cs_by_session" });
    expect((await deliver(e)).status).toBe(200);
    expect(await status()).toBe("paid");
  });

  it("acknowledges payouts, which aren't about an order", async () => {
    const payout = event("payout.paid", { txHash: TX, chainId: 10143, payoutId: "po_1", amount: "100.00", destination: ADDR, automatic: true });
    const res = await deliver(payout);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "ignored" });
    expect(await status()).toBe("awaiting_payment");
  });

  it("answers 404 to a payment for an order it doesn't have, and takes it once the order exists", async () => {
    const early = paidEvent({ orderId: "hcp_notstoredyet", sessionId: null });
    const res = await deliver(early);
    expect(res.status).toBe(404);
    // Not remembered: Polaris will deliver it again.
    expect((await orderStore().read()).events[early.id]).toBeUndefined();
    await orderStore().update((d) => {
      d.orders[orderId]!.payRef = "hcp_notstoredyet";
    });
    expect((await deliver(early)).status).toBe(200);
    expect(await status()).toBe("paid");
  });

  it("acknowledges events that were never a Halcyon order: a dashboard link's payment, the dashboard's test event", async () => {
    const linkPayment = paidEvent({ orderId: "link-pl_ZpcaQPYAGdX0UU-AZLDD2Kudu", sessionId: null });
    const res = await deliver(linkPayment);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: true });
    const test = paidEvent({ orderId: "ord_test_Ab12Cd34", sessionId: null });
    (test.data as { metadata?: Record<string, string> }).metadata = { test: "true" };
    expect((await deliver(test)).status).toBe(200);
    expect(await status()).toBe("awaiting_payment");
  });

  it("flags a payment made to another address", async () => {
    const e = paid();
    (e.data as { merchant: string }).merchant = "0x2222222222222222222222222222222222222222";
    expect(await (await deliver(e)).json()).toMatchObject({ outcome: "flagged" });
    expect(await status()).toBe("needs_review");
  });

  it("a client can't mark an order paid: the order API has no write path", async () => {
    const route = await import("@/app/api/orders/[id]/route");
    expect(Object.keys(route).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    const log = await import("@/app/api/orders/[id]/log/route");
    const res = await log.POST(
      new Request(`https://shop.test/api/orders/${orderId}/log`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify([{ call: "polaris.pay", result: { status: "paid" } }, { call: "markPaid" }]),
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(await res.json()).toMatchObject({ recorded: 1 });
    expect(await status()).toBe("awaiting_payment");
  });
});
