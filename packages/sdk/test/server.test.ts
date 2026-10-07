import { describe, expect, it, vi } from "vitest";

import type { CheckoutSession } from "../src/checkout/types.js";
import { PolarisError } from "../src/errors.js";
import { createPolarisServer } from "../src/server/client.js";

const SECRET_KEY = "sk_test_51Hx8yQfT3sLk2PzR9vWc";
const BASE_URL = "http://localhost:3100";

const session: CheckoutSession = {
  id: "cs_test_a1B2c3D4e5F6g7H8",
  object: "checkout.session",
  url: "http://localhost:3000/pay/cs_test_a1B2c3D4e5F6g7H8",
  status: "open",
  paymentStatus: "unpaid",
  livemode: false,
  amount: "200.00",
  currency: "USD",
  description: "Brand identity package",
  lineItems: [],
  modes: ["now", "later"],
  subscription: null,
  successUrl: "https://studio.example/thanks?session={CHECKOUT_SESSION_ID}",
  cancelUrl: null,
  orderId: "INV-2041",
  metadata: {},
  createdAt: "2026-09-26T12:00:00.000Z",
  expiresAt: "2026-09-27T12:00:00.000Z",
  completedAt: null,
  payment: null,
};

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function server(f: typeof fetch, extra: Partial<Parameters<typeof createPolarisServer>[0]> = {}) {
  return createPolarisServer({ secretKey: SECRET_KEY, baseUrl: BASE_URL, fetch: f, sleep: async () => {}, ...extra });
}

const headersOf = (call: Call) => call.init.headers as Record<string, string>;

describe("createPolarisServer", () => {
  it("refuses a missing, publishable or malformed key", () => {
    const f = fakeFetch([]).fetch;
    expect(() => createPolarisServer({ secretKey: "", baseUrl: BASE_URL, fetch: f })).toThrow(/secretKey/);
    expect(() => createPolarisServer({ secretKey: "pk_test_abcdefgh12345", baseUrl: BASE_URL, fetch: f })).toThrow(/publishable key/);
    expect(() => createPolarisServer({ secretKey: "not-a-key", baseUrl: BASE_URL, fetch: f })).toThrow(/sk_test_/);
  });

  it("requires an https baseUrl, except on localhost", () => {
    const f = fakeFetch([]).fetch;
    expect(() => createPolarisServer({ secretKey: SECRET_KEY, baseUrl: "", fetch: f })).toThrow(/baseUrl/);
    expect(() => createPolarisServer({ secretKey: SECRET_KEY, baseUrl: "http://api.example.com", fetch: f })).toThrow(/https/);
    expect(createPolarisServer({ secretKey: SECRET_KEY, baseUrl: "https://business.example.com/", fetch: f }).baseUrl).toBe(
      "https://business.example.com",
    );
  });

  it("knows test mode from the key", () => {
    expect(server(fakeFetch([]).fetch).livemode).toBe(false);
    expect(createPolarisServer({ secretKey: "sk_live_51Hx8yQfT3sLk2Pz", baseUrl: BASE_URL, fetch: fakeFetch([]).fetch }).livemode).toBe(true);
  });
});

describe("checkout.sessions.create", () => {
  it("POSTs the documented request and returns the session", async () => {
    const { fetch, calls } = fakeFetch([json(201, { data: session })]);
    const created = await server(fetch).checkout.sessions.create(
      {
        amount: "200",
        description: "Brand identity package",
        modes: ["now", "later"],
        successUrl: "https://studio.example/thanks?session={CHECKOUT_SESSION_ID}",
        orderId: "INV-2041",
      },
      { idempotencyKey: "order_2041" },
    );

    expect(created).toEqual(session);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("http://localhost:3100/api/v1/checkout/sessions");
    expect(call!.init.method).toBe("POST");
    expect(headersOf(call!)).toMatchObject({
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Idempotency-Key": "order_2041",
      "Polaris-Client": "polarispay-sdk/0.3.0",
    });
    expect(JSON.parse(call!.init.body as string)).toEqual({
      amount: "200.00",
      currency: "USD",
      description: "Brand identity package",
      lineItems: [],
      modes: ["now", "later"],
      subscription: null,
      successUrl: "https://studio.example/thanks?session={CHECKOUT_SESSION_ID}",
      cancelUrl: null,
      orderId: "INV-2041",
      metadata: {},
    });
  });

  it("totals line items, and defaults modes and subscription terms", async () => {
    const { fetch, calls } = fakeFetch([json(200, { data: session })]);
    await server(fetch).checkout.sessions.create({
      description: "Studio retainer",
      lineItems: [
        { name: "Logo", unitAmount: "150.00" },
        { name: "Revisions", quantity: 2, unitAmount: "25" },
      ],
      modes: ["subscribe", "now"],
      successUrl: "https://studio.example/thanks",
      cancelUrl: "https://studio.example/cart",
      metadata: { cart: "c_9" },
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.amount).toBe("200.00");
    expect(body.lineItems).toEqual([
      { name: "Logo", quantity: 1, unitAmount: "150.00" },
      { name: "Revisions", quantity: 2, unitAmount: "25.00" },
    ]);
    expect(body.subscription).toEqual({ interval: "month", intervalCount: 1 });
    expect(body.cancelUrl).toBe("https://studio.example/cart");
    expect(body.metadata).toEqual({ cart: "c_9" });
  });

  it("sends a generated idempotency key when none is given, and reuses it on retries", async () => {
    const { fetch, calls } = fakeFetch([
      json(503, { error: { code: "unavailable", message: "Try again" } }),
      new TypeError("fetch failed"),
      json(201, { data: session }),
    ]);
    const created = await server(fetch).checkout.sessions.create({ amount: "5.00", description: "Coffee", successUrl: "https://cafe.example/ok" });
    expect(created.id).toBe(session.id);
    expect(calls).toHaveLength(3);
    const keys = calls.map((c) => headersOf(c)["Idempotency-Key"]);
    expect(keys[0]).toMatch(/^sdk_/);
    expect(new Set(keys).size).toBe(1);
  });

  it("honours Retry-After on 429", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch } = fakeFetch([json(429, { error: { code: "rate_limited", message: "Slow down" } }, { "retry-after": "2" }), json(201, { data: session })]);
    await server(fetch, { sleep }).checkout.sessions.create({ amount: "5.00", description: "Coffee", successUrl: "https://cafe.example/ok" });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does not retry a 4xx, and maps the error", async () => {
    const { fetch, calls } = fakeFetch([
      json(400, { error: { code: "invalid_amount", message: "amount is too small", param: "amount" } }, { "polaris-request-id": "req_123" }),
    ]);
    const err = await server(fetch)
      .checkout.sessions.create({ amount: "5.00", description: "Coffee", successUrl: "https://cafe.example/ok" })
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(PolarisError);
    expect(err).toMatchObject({ type: "invalid_request_error", code: "invalid_amount", status: 400, param: "amount", requestId: "req_123", message: "amount is too small" });
  });

  it.each([
    [401, "invalid_api_key", "authentication_error"],
    [403, "forbidden", "permission_error"],
    [409, "idempotency_key_reused", "idempotency_error"],
    [500, "internal", "api_error"],
  ] as const)("maps HTTP %i to %s", async (status, code, type) => {
    const responses = Array.from({ length: 3 }, () => json(status, { error: { code, message: "nope" } }));
    const { fetch } = fakeFetch(responses);
    await expect(
      server(fetch).checkout.sessions.create({ amount: "5.00", description: "Coffee", successUrl: "https://cafe.example/ok" }),
    ).rejects.toMatchObject({ type, code, status });
  });

  it("gives up after maxRetries on network errors", async () => {
    const { fetch, calls } = fakeFetch([new TypeError("down"), new TypeError("down"), new TypeError("down")]);
    await expect(
      server(fetch).checkout.sessions.create({ amount: "5.00", description: "Coffee", successUrl: "https://cafe.example/ok" }),
    ).rejects.toMatchObject({ type: "connection_error", code: "network_error" });
    expect(calls).toHaveLength(3);
  });

  it("times out a request that never answers", async () => {
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const polaris = createPolarisServer({ secretKey: SECRET_KEY, baseUrl: BASE_URL, fetch: hang as typeof fetch, timeoutMs: 20, maxRetries: 0 });
    await expect(
      polaris.checkout.sessions.create({ amount: "5.00", description: "Coffee", successUrl: "https://cafe.example/ok" }),
    ).rejects.toMatchObject({ type: "connection_error", code: "timeout" });
  });

  it("validates parameters before sending anything", async () => {
    const { fetch, calls } = fakeFetch([]);
    const create = server(fetch).checkout.sessions.create;
    const base = { amount: "10.00", description: "Thing", successUrl: "https://shop.example/ok" };
    await expect(create({ ...base, amount: "10.001" })).rejects.toMatchObject({ param: "amount" });
    await expect(create({ ...base, currency: "EUR" as never })).rejects.toMatchObject({ code: "invalid_currency" });
    await expect(create({ ...base, description: "" })).rejects.toMatchObject({ param: "description" });
    await expect(create({ ...base, modes: [] })).rejects.toMatchObject({ code: "invalid_modes" });
    await expect(create({ ...base, modes: ["now", "now"] })).rejects.toMatchObject({ code: "invalid_modes" });
    await expect(create({ ...base, modes: ["crypto" as never] })).rejects.toMatchObject({ code: "invalid_modes" });
    await expect(create({ ...base, successUrl: "http://shop.example/ok" })).rejects.toMatchObject({ code: "insecure_url" });
    await expect(create({ ...base, successUrl: "/thanks" })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(create({ ...base, lineItems: [{ name: "A", unitAmount: "4.00" }] })).rejects.toMatchObject({ code: "amount_mismatch" });
    await expect(create({ ...base, subscription: { interval: "month" } })).rejects.toMatchObject({ code: "invalid_subscription" });
    await expect(create({ ...base, modes: ["subscribe"], subscription: { interval: "fortnight" as never } })).rejects.toMatchObject({
      code: "invalid_subscription",
    });
    await expect(create({ ...base, metadata: { big: "x".repeat(501) } })).rejects.toMatchObject({ code: "invalid_metadata" });
    await expect(create({ ...base, metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) })).rejects.toMatchObject({
      code: "invalid_metadata",
    });
    await expect(create(base, { idempotencyKey: "x".repeat(256) })).rejects.toMatchObject({ code: "invalid_idempotency_key" });
    expect(calls).toHaveLength(0);
  });

  it("allows http successUrl on localhost for development", async () => {
    const { fetch } = fakeFetch([json(201, { data: session })]);
    await expect(
      server(fetch).checkout.sessions.create({ amount: "1.00", description: "Dev", successUrl: "http://localhost:3520/thanks" }),
    ).resolves.toBeTruthy();
  });
});

describe("checkout.sessions.retrieve", () => {
  it("GETs the session by id", async () => {
    const { fetch, calls } = fakeFetch([json(200, { data: { ...session, status: "complete" } })]);
    const got = await server(fetch).checkout.sessions.retrieve(session.id);
    expect(got.status).toBe("complete");
    expect(calls[0]!.url).toBe(`http://localhost:3100/api/v1/checkout/sessions/${session.id}`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(headersOf(calls[0]!)).toMatchObject({ Authorization: `Bearer ${SECRET_KEY}` });
    expect(headersOf(calls[0]!)["Idempotency-Key"]).toBeUndefined();
  });

  it("retries a GET without an idempotency key", async () => {
    const { fetch, calls } = fakeFetch([json(502, {}), json(200, { data: session })]);
    await server(fetch).checkout.sessions.retrieve(session.id);
    expect(calls).toHaveLength(2);
  });

  it("refuses anything that isn't a session id (no path injection)", async () => {
    const { fetch, calls } = fakeFetch([]);
    await expect(server(fetch).checkout.sessions.retrieve("../keys")).rejects.toMatchObject({ code: "invalid_session_id" });
    await expect(server(fetch).checkout.sessions.retrieve("cs_test_abc/../../x")).rejects.toMatchObject({ code: "invalid_session_id" });
    expect(calls).toHaveLength(0);
  });

  it("raises a 404 as an invalid request", async () => {
    const { fetch } = fakeFetch([json(404, { error: { code: "not_found", message: "No such session" } })]);
    await expect(server(fetch).checkout.sessions.retrieve(session.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("webhooks on the server client", () => {
  it("verifies with the configured tolerance and signs test headers", () => {
    const polaris = server(fakeFetch([]).fetch, { webhookToleranceSeconds: 5 });
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "payout.paid", createdAt: "", livemode: false, merchantId: "m", data: {} });
    const now = Math.floor(Date.now() / 1000);
    const header = polaris.webhooks.generateTestHeader({ payload, secret: "whsec_x", timestamp: now - 10 });
    expect(() => polaris.webhooks.verify(payload, header, "whsec_x")).toThrow(/tolerance/);
    expect(polaris.webhooks.verify(payload, header, "whsec_x", { toleranceSeconds: 60 }).type).toBe("payout.paid");
  });
});

describe("the credit guard on the server client", () => {
  it("reads GET /api/public/credit-guard: whether new Pay in 4 plans can open", async () => {
    const guard = {
      state: "paused",
      paused: true,
      reasons: ["depeg"],
      message: "Pay in 4 is paused by our risk guard; pay now works as usual.",
      checkedAt: "2026-10-02T12:00:00.000Z",
      ageSeconds: 42,
      readAt: "2026-10-02T12:00:42.000Z",
    };
    const { fetch, calls } = fakeFetch([json(200, { data: guard })]);
    const out = await server(fetch).credit.guard();
    expect(out).toEqual(guard);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/public/credit-guard`);
    expect(calls[0]!.init.method).toBe("GET");
  });
});
