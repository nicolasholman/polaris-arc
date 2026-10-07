import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/checkout/route";
import { createMemoryStore, orderStore, setOrderStore } from "@/lib/orders/store";

import { SECRET, checkoutBody } from "./helpers";

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

let calls: Call[] = [];
let sessionCounter = 0;

function polarisFetch(respond?: (call: Call) => Response | undefined) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const custom = respond?.(call);
    if (custom) return custom;
    sessionCounter += 1;
    return Response.json({
      id: `cs_test_${sessionCounter}`,
      object: "checkout.session",
      url: `https://pay.polaris.test/pay/cs_test_${sessionCounter}`,
      status: "open",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
  });
}

function post(body: unknown, key?: string, extra: Record<string, string> = {}) {
  return POST(
    new Request("https://shop.test/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...extra },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  calls = [];
  setOrderStore(createMemoryStore());
  vi.stubEnv("POLARIS_API_BASE", "https://api.polaris.test");
  vi.stubEnv("POLARIS_SECRET_KEY", "sk_test_shopsecret123");
  vi.stubEnv("POLARIS_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY", "pk_test_shoppublic123");
  vi.stubEnv("NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN", "https://pay.polaris.test");
  vi.stubEnv("POLARIS_MERCHANT_ADDRESS", "0x1111111111111111111111111111111111111111");
  vi.stubGlobal("fetch", polarisFetch());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/checkout (Polaris)", () => {
  it("creates the order, then a checkout session through the SDK, and returns its URL", async () => {
    const res = await post(checkoutBody({ method: "polaris", mode: "later" }), "hc_attempt_1_abc");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { order: { id: string; status: string; total: number }; checkout: { sessionId: string; url: string } };
    expect(json.order.status).toBe("awaiting_payment");
    expect(json.order.total).toBe(34900);
    expect(json.checkout.url).toMatch(/^https:\/\/pay\.polaris\.test\/pay\//);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://api.polaris.test/api/v1/checkout/sessions");
    expect(call!.method).toBe("POST");
    expect(call!.headers.authorization).toBe("Bearer sk_test_shopsecret123");
    expect(call!.headers["idempotency-key"]).toBe(`${json.order.id}:session:0`);
    // Exactly polarispay-sdk's POST /api/v1/checkout/sessions body.
    expect(call!.body).toEqual({
      amount: "349.00",
      currency: "USD",
      description: expect.stringMatching(/^Halcyon order HC-\d{5}$/),
      lineItems: [{ name: "Halcyon One, Graphite", quantity: 1, unitAmount: "349.00" }],
      modes: ["later", "now"],
      subscription: null,
      successUrl: `https://shop.test/orders/${json.order.id}?via=polaris`,
      cancelUrl: `https://shop.test/checkout?order=${json.order.id}&canceled=1`,
      // The payRef, never the order id: Polaris may write it on chain.
      orderId: expect.stringMatching(/^hcp_[a-z2-7]{20}$/),
      metadata: { orderNumber: expect.stringMatching(/^HC-\d{5}$/) },
    });

    const stored = (await orderStore().read()).orders[json.order.id]!;
    expect(call!.body!.orderId).toBe(stored.payRef);
    // This browser gets the cookie that lets it read the order back.
    expect(res.headers.get("set-cookie")).toBe(`hc_o_${stored.id}=${stored.accessToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`);
    expect(stored.payment.sessionId).toBe(json.checkout.sessionId);
    expect(stored.sdkLog[0]?.call).toBe("polaris.checkout.sessions.create");
    expect(call!.headers["polaris-client"]).toBe("polarispay-sdk/0.3.0");
    // The drawer's log never carries a key.
    expect(JSON.stringify(stored.sdkLog)).not.toContain("sk_test");
  });

  it("prices from the catalogue, not the browser", async () => {
    const body = checkoutBody({ method: "polaris", mode: "now" }, [{ productId: "arc-lamp", optionId: "chalk-brass", quantity: 1, price: 1 }]);
    const res = await post(body, "hc_attempt_price_1");
    const json = (await res.json()) as { order: { total: number } };
    expect(json.order.total).toBe(15900);
    expect(calls[0]!.body!.amount).toBe("159.00");
  });

  it("is idempotent: the same key and body return the same order and session, with no second session", async () => {
    const first = (await (await post(checkoutBody(), "hc_attempt_same_1")).json()) as { order: { id: string }; checkout: { url: string } };
    const second = (await (await post(checkoutBody(), "hc_attempt_same_1")).json()) as { order: { id: string }; checkout: { url: string }; reused: boolean };
    expect(second.order.id).toBe(first.order.id);
    expect(second.checkout.url).toBe(first.checkout.url);
    expect(second.reused).toBe(true);
    expect(calls).toHaveLength(1);
    expect(Object.keys((await orderStore().read()).orders)).toHaveLength(1);
  });

  it("refuses the same key with a different body", async () => {
    await post(checkoutBody({ method: "polaris", mode: "later" }), "hc_attempt_conflict");
    const res = await post(checkoutBody({ method: "polaris", mode: "now" }), "hc_attempt_conflict");
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("opens a new session, under a new idempotency key, once the old one has expired", async () => {
    vi.stubGlobal(
      "fetch",
      polarisFetch(() =>
        Response.json({ id: "cs_old", object: "checkout.session", url: "https://pay.polaris.test/pay/cs_old", status: "open", expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ),
    );
    const first = (await (await post(checkoutBody(), "hc_attempt_expired")).json()) as { order: { id: string } };
    vi.stubGlobal("fetch", polarisFetch());
    await post(checkoutBody(), "hc_attempt_expired");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["idempotency-key"]).toBe(`${first.order.id}:session:1`);
  });

  it("retries a 5xx from Polaris with the same idempotency key", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      polarisFetch(() => (++n === 1 ? Response.json({ error: { message: "busy" } }, { status: 503 }) : undefined)),
    );
    const res = await post(checkoutBody(), "hc_attempt_retry_1");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["idempotency-key"]).toBe(calls[1]!.headers["idempotency-key"]);
  });

  it("answers 502 with a buyer-safe message when Polaris is down, and logs the failed call", async () => {
    vi.stubGlobal("fetch", polarisFetch(() => Response.json({ error: { type: "invalid_request_error", message: "nope" } }, { status: 400 })));
    const res = await post(checkoutBody(), "hc_attempt_down_1");
    expect(res.status).toBe(502);
    const order = Object.values((await orderStore().read()).orders)[0]!;
    expect(order.status).toBe("awaiting_payment");
    expect(order.sdkLog[0]?.error).toBe("nope");
  });

  it("validates the request", async () => {
    const res = await post({ ...checkoutBody(), contact: { email: "not-an-email" } }, "hc_attempt_invalid");
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { fields: Record<string, string> } };
    expect(json.error.fields["contact.email"]).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("only lets the Coffee Club check out as a subscription, alone", async () => {
    const club = [{ productId: "coffee-club", optionId: "filter", quantity: 1 }];
    expect((await post(checkoutBody({ method: "polaris", mode: "now" }, club), "hc_attempt_sub_1")).status).toBe(422);
    expect((await post(checkoutBody({ method: "wallet" }, club), "hc_attempt_sub_2")).status).toBe(422);
    const mixed = [...club, { productId: "keys-75", optionId: "linear", quantity: 1 }];
    expect((await post(checkoutBody({ method: "polaris", mode: "subscribe" }, mixed), "hc_attempt_sub_3")).status).toBe(422);
    const ok = await post(checkoutBody({ method: "polaris", mode: "subscribe" }, club), "hc_attempt_sub_4");
    expect(ok.status).toBe(200);
    expect(calls[0]!.body).toMatchObject({ amount: "18.00", modes: ["subscribe"], subscription: { interval: "month", intervalCount: 1 } });
    expect(calls[0]!.body!.lineItems).toEqual([{ name: "Halcyon Coffee Club, Filter", quantity: 1, unitAmount: "18.00" }]);
    // Canceling in Polaris comes back to the subscription's own checkout, not an empty bag.
    expect(calls[0]!.body!.cancelUrl).toBe("https://shop.test/checkout?subscribe=coffee-club&option=filter&canceled=1");
  });
});

describe("POST /api/checkout (wallet)", () => {
  it("returns what pay() needs, and calls nothing at Polaris", async () => {
    const res = await post(checkoutBody({ method: "wallet" }), "hc_attempt_wallet_1");
    const json = (await res.json()) as { order: { id: string }; wallet: { merchant: string; amount: string; orderId: string } };
    const stored = (await orderStore().read()).orders[json.order.id]!;
    // pay() signs for the payRef, which goes on chain in PaymentMade; the order id stays off chain.
    expect(json.wallet).toEqual({ merchant: "0x1111111111111111111111111111111111111111", amount: "349.00", orderId: stored.payRef });
    expect(json.wallet.orderId).toMatch(/^hcp_[a-z2-7]{20}$/);
    expect(json.order.id).toMatch(/^hc_[a-z2-7]{20}$/);
    expect(calls).toHaveLength(0);
  });

  it("switching an unpaid order to the wallet keeps the order, so the chain can't be paid twice for it", async () => {
    const first = await post(checkoutBody({ method: "polaris", mode: "later" }), "hc_attempt_switch_1");
    const a = (await first.json()) as { order: { id: string } };
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const res = await post({ ...checkoutBody({ method: "wallet" }), continueOrder: a.order.id }, "hc_attempt_switch_2", { cookie });
    const b = (await res.json()) as { order: { id: string }; wallet: { orderId: string } };
    expect(b.order.id).toBe(a.order.id);
    const stored = (await orderStore().read()).orders[a.order.id]!;
    expect(b.wallet.orderId).toBe(stored.payRef);
    expect(stored.payment.method).toBe("wallet");
    expect(Object.keys((await orderStore().read()).orders)).toHaveLength(1);
  });

  it("only the browser that placed an order can continue it, and only for the same goods", async () => {
    const first = await post(checkoutBody({ method: "polaris", mode: "later" }), "hc_attempt_switch_3");
    const a = (await first.json()) as { order: { id: string } };
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const stranger = (await (await post({ ...checkoutBody({ method: "wallet" }), continueOrder: a.order.id }, "hc_attempt_switch_4")).json()) as { order: { id: string } };
    expect(stranger.order.id).not.toBe(a.order.id);
    const lamp = [{ productId: "arc-lamp", optionId: "chalk-brass", quantity: 1 }];
    const changed = (await (await post({ ...checkoutBody({ method: "wallet" }, lamp), continueOrder: a.order.id }, "hc_attempt_switch_5", { cookie })).json()) as { order: { id: string } };
    expect(changed.order.id).not.toBe(a.order.id);
  });

  it("a new mode for the same order opens a new session instead of reusing the old one", async () => {
    const first = await post(checkoutBody({ method: "polaris", mode: "later" }), "hc_attempt_mode_1");
    const a = (await first.json()) as { order: { id: string }; checkout: { sessionId: string } };
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const res = await post({ ...checkoutBody({ method: "polaris", mode: "now" }), continueOrder: a.order.id }, "hc_attempt_mode_2", { cookie });
    const b = (await res.json()) as { order: { id: string }; checkout: { sessionId: string } };
    expect(b.order.id).toBe(a.order.id);
    expect(b.checkout.sessionId).not.toBe(a.checkout.sessionId);
    expect(calls[1]!.body).toMatchObject({ modes: ["now"] });
    expect(calls[1]!.headers["idempotency-key"]).toBe(`${a.order.id}:session:1`);
  });
});

describe("POST /api/checkout (the store's origin)", () => {
  const forged = { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" };

  it("ignores X-Forwarded-Host unless TRUST_PROXY=1", async () => {
    await post(checkoutBody(), "hc_attempt_fwd_1", forged);
    expect(calls[0]!.body!.successUrl).toMatch(/^https:\/\/shop\.test\/orders\//);
    vi.stubEnv("TRUST_PROXY", "1");
    await post(checkoutBody(), "hc_attempt_fwd_2", forged);
    expect(calls[1]!.body!.successUrl).toMatch(/^https:\/\/attacker\.example\/orders\//);
  });

  it("takes success and cancel URLs from SHOP_URL, which production requires", async () => {
    vi.stubEnv("SHOP_URL", "https://halcyon.example");
    await post(checkoutBody(), "hc_attempt_pinned_1", forged);
    expect(calls[0]!.body!.successUrl).toMatch(/^https:\/\/halcyon\.example\/orders\//);
    vi.stubEnv("SHOP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect((await post(checkoutBody(), "hc_attempt_pinned_2")).status).toBe(503);
  });
});

describe("POST /api/checkout (not configured)", () => {
  for (const nodeEnv of ["production", "development"]) {
    it(`says payments aren't configured, places no order and calls nothing (${nodeEnv})`, async () => {
      vi.stubEnv("POLARIS_API_BASE", "");
      vi.stubEnv("POLARIS_SECRET_KEY", "");
      vi.stubEnv("NODE_ENV", nodeEnv);
      const res = await post(checkoutBody(), `hc_attempt_${nodeEnv}_1`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string; detail?: string } };
      expect(body.error.code).toBe("payments_not_configured");
      expect(body.error.message).toBe("Payments aren't configured on this store.");
      // Which settings are missing only in development; never a session URL, never "paid".
      if (nodeEnv === "development") expect(body.error.detail).toMatch(/POLARIS_API_BASE, POLARIS_SECRET_KEY/);
      else expect(body.error.detail).toBeUndefined();
      expect(body).not.toHaveProperty("checkout");
      expect(body).not.toHaveProperty("order");
      expect(calls).toHaveLength(0);
      expect(Object.keys((await orderStore().read()).orders)).toHaveLength(0);
    });
  }
});
