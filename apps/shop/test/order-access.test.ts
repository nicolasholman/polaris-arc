import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/orders/[id]/route";
import { POST as LOG } from "@/app/api/orders/[id]/log/route";
import { BROWSER_LOG_GRACE_MS, MAX_BROWSER_LOG, SYNC_INTERVAL_MS, claimSync, createOrder } from "@/lib/orders/service";
import { createMemoryStore, orderStore, setOrderStore } from "@/lib/orders/store";
import type { Order } from "@/lib/orders/types";

import { SECRET, priced } from "./helpers";

let order: Order;
let cookie = "";
let retrieves = 0;

function get(id: string, withCookie: boolean, query = "") {
  return GET(new Request(`https://shop.test/api/orders/${id}${query}`, { headers: withCookie ? { cookie } : {} }), { params: Promise.resolve({ id }) });
}

function log(id: string, entries: unknown, withCookie = true) {
  return LOG(new Request(`https://shop.test/api/orders/${id}/log`, { method: "POST", headers: withCookie ? { cookie } : {}, body: JSON.stringify(entries) }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(async () => {
  setOrderStore(createMemoryStore());
  retrieves = 0;
  vi.stubEnv("POLARIS_API_BASE", "https://api.polaris.test");
  vi.stubEnv("POLARIS_SECRET_KEY", "sk_test_shopsecret123");
  vi.stubEnv("POLARIS_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY", "pk_test_shoppublic123");
  vi.stubEnv("NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN", "https://pay.polaris.test");
  vi.stubEnv("POLARIS_MERCHANT_ADDRESS", "0x1111111111111111111111111111111111111111");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      retrieves += 1;
      return Response.json({ id: "cs_test_a1b2c3d4e5f6", object: "checkout.session", status: "open", payment: null });
    }),
  );
  const created = await createOrder(priced(), "hc_access_test");
  if (!created.ok) throw new Error("no order");
  await orderStore().update((d) => {
    d.orders[created.order.id]!.payment.sessionId = "cs_test_a1b2c3d4e5f6";
  });
  order = (await orderStore().read()).orders[created.order.id]!;
  cookie = `hc_o_${order.id}=${order.accessToken}`;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reading an order", () => {
  it("gives the browser that placed it the whole order, but never its access token", async () => {
    const json = (await (await get(order.id, true)).json()) as { order: Order };
    expect(json.order.address.line1).toBe("Torstraße 118");
    expect(json.order.contact.email).toBe("lena@example.com");
    expect(json.order.redacted).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain(order.accessToken!);
  });

  it("masks the buyer's details for anyone else who has the link", async () => {
    const res = await get(order.id, false);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { order: Order };
    expect(json.order.redacted).toBe(true);
    expect(json.order.contact.email).toBe("l***@example.com");
    expect(json.order.address).toEqual({ name: "", line1: "", city: "", postalCode: "", country: "" });
    expect(json.order.status).toBe("awaiting_payment");
    expect(json.order.lines).toHaveLength(1);
    const text = JSON.stringify(json);
    for (const secret of ["Lena", "Torstraße", "lena@", order.accessToken!]) expect(text).not.toContain(secret);
  });

  it("a wrong token reads like no token", async () => {
    const res = await GET(new Request(`https://shop.test/api/orders/${order.id}`, { headers: { cookie: `hc_o_${order.id}=nope` } }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(((await res.json()) as { order: Order }).order.redacted).toBe(true);
  });
});

describe("asking Polaris about the session (?sync=1)", () => {
  it("only for the browser that placed the order, and at most once every 10 seconds", async () => {
    await get(order.id, false, "?sync=1");
    expect(retrieves).toBe(0);
    for (let i = 0; i < 20; i++) await get(order.id, true, "?sync=1");
    expect(retrieves).toBe(1);
    const stored = (await orderStore().read()).orders[order.id]!;
    expect(stored.sdkLog.filter((c) => c.call === "polaris.checkout.sessions.retrieve")).toHaveLength(1);
  });

  it("never once the order is paid", async () => {
    const later = new Date(Date.now() + SYNC_INTERVAL_MS + 1);
    await orderStore().update((d) => {
      d.orders[order.id]!.status = "paid";
    });
    expect(await claimSync(order.id, orderStore(), later)).toBe(false);
  });
});

describe("the developer drawer's browser log", () => {
  it("refuses a browser that didn't place the order", async () => {
    expect((await log(order.id, [{ call: "polaris.pay", result: { ok: true, transactionHash: "0xdeadbeef" } }], false)).status).toBe(403);
  });

  it("takes a handful of entries while the order is unpaid", async () => {
    const entry = { call: "polaris.openCheckout", result: { status: "closed" } };
    let recorded = 0;
    for (let i = 0; i < 3; i++) recorded += ((await (await log(order.id, Array(6).fill(entry))).json()) as { recorded: number }).recorded;
    expect(recorded).toBe(MAX_BROWSER_LOG);
  });

  it("stays open for the checkout's own result just after payment, then closes", async () => {
    const entry = { call: "polaris.openCheckout", result: { status: "completed" } };
    await orderStore().update((d) => {
      d.orders[order.id]!.status = "paid";
      d.orders[order.id]!.payment.paidAt = new Date().toISOString();
    });
    expect(((await (await log(order.id, [entry])).json()) as { recorded: number }).recorded).toBe(1);
    await orderStore().update((d) => {
      d.orders[order.id]!.payment.paidAt = new Date(Date.now() - BROWSER_LOG_GRACE_MS - 1000).toISOString();
    });
    expect((await log(order.id, [entry])).status).toBe(409);
  });
});
