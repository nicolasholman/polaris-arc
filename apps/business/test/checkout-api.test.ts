import { beforeEach, describe, expect, it } from "vitest";

import { POST as createKey } from "@/app/api/keys/route";
import { DELETE as revokeKey } from "@/app/api/keys/[id]/route";
import { GET as publicGet } from "@/app/api/public/sessions/[id]/route";
import { POST as createSessionRoute } from "@/app/api/v1/checkout/sessions/route";
import { GET as retrieveRoute } from "@/app/api/v1/checkout/sessions/[id]/route";
import { getDb } from "@/server/db";

import { buildCreateBody } from "../../../packages/sdk/src/server/checkout-params";
import { createPolarisServer } from "../../../packages/sdk/src/server";
import { json, params, request, setupServer, signIn } from "./helpers/env";
import { emitLikeTheContracts } from "./helpers/flows";

const MERCHANT_WALLET = "0x2222222222222222222222222222222222222222";

async function newKeys(userId = "did:privy:merchant-1", wallet = MERCHANT_WALLET) {
  signIn({ userId, walletAddress: wallet as `0x${string}` });
  const res = await json(await createKey(request("POST", "/api/keys", { body: { name: "Server" } }), params({})));
  expect(res.status).toBe(201);
  return res.body.data as { key: { id: string; publishableKey: string }; secret: string };
}

const body = (over: Record<string, unknown> = {}) => ({
  amount: "200.00",
  currency: "USD",
  description: "Brand identity package",
  lineItems: [
    { name: "Logo", quantity: 1, unitAmount: "150.00" },
    { name: "Revisions", quantity: 2, unitAmount: "25.00" },
  ],
  modes: ["now", "later"],
  subscription: null,
  successUrl: "https://studio.example/thanks?session={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://studio.example/cart",
  orderId: "INV-2041",
  metadata: { invoice: "2041" },
  ...over,
});

function create(secret: string | null, payload: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return createSessionRoute(request("POST", "/api/v1/checkout/sessions", { body: payload, headers }), params({}));
}

beforeEach(() => {
  emitLikeTheContracts(setupServer());
});

describe("POST /api/v1/checkout/sessions: authentication", () => {
  it("refuses no key, an unknown key and a revoked key with 401 invalid_api_key", async () => {
    const { secret, key } = await newKeys();
    const none = await json(await create(null, body()));
    expect(none.status).toBe(401);
    expect(none.body.error).toMatchObject({ code: "invalid_api_key" });
    const unknown = await json(await create(`sk_test_${"x".repeat(40)}`, body()));
    expect(unknown.status).toBe(401);
    await revokeKey(request("DELETE", `/api/keys/${key.id}`), params({ id: key.id }));
    expect((await create(secret, body())).status).toBe(401);
  });

  it("refuses a publishable key with 403: it's for browsers", async () => {
    const { key } = await newKeys();
    const res = await json(await create(key.publishableKey, body()));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("secret_key_required");
  });

  it("stores only a peppered hash of the secret key", async () => {
    const { secret, key } = await newKeys();
    const stored = await getDb().apiKeys.get(key.id);
    expect(stored?.secretHash).toMatch(/^hmac256:[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored?.secretHint).toBe(`sk_test_…${secret.slice(-4)}`);
  });

  it("answers every response with a Polaris-Request-Id", async () => {
    const res = await create(null, body());
    expect(res.headers.get("polaris-request-id")).toMatch(/^req_/);
  });
});

describe("POST /api/v1/checkout/sessions: the session", () => {
  it("creates exactly the SDK's CheckoutSession", async () => {
    const { secret } = await newKeys();
    const res = await json(await create(secret, body(), "order_2041"));
    expect(res.status).toBe(201);
    const s = res.body.data;
    expect(s.id).toMatch(/^cs_test_[A-Za-z0-9]{8,128}$/);
    expect(s).toMatchObject({
      object: "checkout.session",
      url: `http://localhost:3000/pay/${s.id}`,
      status: "open",
      paymentStatus: "unpaid",
      livemode: false,
      amount: "200.00",
      currency: "USD",
      description: "Brand identity package",
      lineItems: [
        { name: "Logo", quantity: 1, unitAmount: "150.00", amount: "150.00" },
        { name: "Revisions", quantity: 2, unitAmount: "25.00", amount: "50.00" },
      ],
      modes: ["now", "later"],
      subscription: null,
      successUrl: "https://studio.example/thanks?session={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://studio.example/cart",
      orderId: "INV-2041",
      metadata: { invoice: "2041" },
      completedAt: null,
      payment: null,
    });
    expect(Date.parse(s.expiresAt) - Date.parse(s.createdAt)).toBe(24 * 3600 * 1000);
    expect(Object.keys(s).sort()).toEqual(
      ["amount", "cancelUrl", "completedAt", "createdAt", "currency", "description", "expiresAt", "id", "lineItems", "livemode", "metadata", "modes", "object", "orderId", "payment", "paymentStatus", "status", "subscription", "successUrl", "url"].sort(),
    );
  });

  it("defaults monthly terms for subscribe and refuses subscription terms without it", async () => {
    const { secret } = await newKeys();
    const sub = await json(await create(secret, body({ lineItems: [], amount: "9.99", modes: ["subscribe"], subscription: { interval: "month", intervalCount: 1 } })));
    expect(sub.status).toBe(201);
    expect(sub.body.data.subscription).toEqual({ interval: "month", intervalCount: 1 });
    const bad = await json(await create(secret, body({ subscription: { interval: "week", intervalCount: 1 } })));
    expect(bad.body.error).toMatchObject({ code: "invalid_subscription", param: "subscription" });
  });

  it("refuses a second session for an order that is already paid", async () => {
    const { secret } = await newKeys();
    const first = await json(await create(secret, body()));
    await getDb().sessions.update(first.body.data.id, (s) => ({ ...s, status: "complete" }));
    const again = await json(await create(secret, body()));
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "order_already_paid", param: "orderId" });
  });

  it("needs the merchant's payout wallet to exist", async () => {
    const { secret } = await newKeys("did:privy:no-wallet", MERCHANT_WALLET);
    await getDb().merchants.update("did:privy:no-wallet", (m) => ({ ...m, walletAddress: null }));
    const res = await json(await create(secret, body()));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("account_incomplete");
  });
});

describe("validation matches polarispay-sdk's buildCreateBody", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["line items that don't add up", { amount: "199.00" }],
    ["an http success URL", { successUrl: "http://studio.example/thanks" }],
    ["a relative success URL", { successUrl: "/thanks" }],
    ["no success URL", { successUrl: undefined }],
    ["an unknown mode", { modes: ["now", "crypto"] }],
    ["a duplicate mode", { modes: ["now", "now"] }],
    ["no modes", { modes: [] }],
    ["a subscription without subscribe", { subscription: { interval: "month" } }],
    ["a bad interval", { lineItems: [], modes: ["subscribe"], subscription: { interval: "hour" } }],
    ["intervalCount 13", { lineItems: [], modes: ["subscribe"], subscription: { interval: "month", intervalCount: 13 } }],
    ["a non-USD currency", { currency: "EUR" }],
    ["no description", { description: "" }],
    ["a 501-character description", { description: "x".repeat(501) }],
    ["21 metadata keys", { metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) }],
    ["a non-string metadata value", { metadata: { n: 1 } }],
    ["a 41-character metadata key", { metadata: { ["k".repeat(41)]: "v" } }],
    ["an empty orderId", { orderId: "" }],
    ["a line item with quantity 0", { amount: undefined, lineItems: [{ name: "x", quantity: 0, unitAmount: "1.00" }] }],
    ["no amount and no line items", { amount: undefined, lineItems: [] }],
    ["a malformed amount", { lineItems: [], amount: "12.345" }],
    ["too large an amount", { lineItems: [], amount: "1000000.01" }],
  ];

  it.each(cases)("refuses %s with the SDK's code and param", async (_label, over) => {
    const { secret } = await newKeys();
    const payload = body(over);
    let sdk: { code?: string; param?: string } | null = null;
    // The SDK's params are the wire body without its explicit nulls.
    const sdkParams = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null));
    try {
      buildCreateBody(sdkParams as never);
    } catch (error) {
      sdk = error as { code?: string; param?: string };
    }
    const res = await json(await create(secret, payload));
    expect(res.status).toBe(400);
    if (sdk) {
      expect(res.body.error.code).toBe(sdk.code);
      if (sdk.param) expect(res.body.error.param).toBe(sdk.param);
    }
  });

  it("accepts every body the SDK builds", async () => {
    const { secret } = await newKeys();
    for (const params of [
      { amount: "25.00", description: "Coffee", successUrl: "https://shop.example/ok" },
      { lineItems: [{ name: "Mug", unitAmount: "12.50", quantity: 2 }], description: "Mugs", successUrl: "http://localhost:4000/ok", orderId: "o-1" },
      { amount: 9.99, description: "Pro", modes: ["subscribe" as const], subscription: { interval: "year" as const }, successUrl: "https://x.example/{CHECKOUT_SESSION_ID}" },
    ]) {
      const res = await create(secret, buildCreateBody(params as never));
      expect(res.status, JSON.stringify(params)).toBe(201);
    }
  });
});

describe("Idempotency-Key", () => {
  it("replays the first session with 200 for the same key and body", async () => {
    const { secret } = await newKeys();
    const first = await json(await create(secret, body(), "key-1"));
    const second = await json(await create(secret, body(), "key-1"));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await getDb().sessions.count()).toBe(1);
  });

  it("refuses the same key with different parameters: 409 idempotency_key_reused", async () => {
    const { secret } = await newKeys();
    await create(secret, body(), "key-2");
    const res = await json(await create(secret, body({ description: "Something else" }), "key-2"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("idempotency_key_reused");
  });

  it("answers 409 idempotency_in_progress while the first request runs", async () => {
    const { secret } = await newKeys();
    const merchant = await getDb().merchants.get("did:privy:merchant-1");
    const { fingerprint } = await import("@/server/sessions/idempotency");
    await getDb().idempotency.insert({
      id: `sessions:${merchant?.id}:key-3`,
      requestHash: fingerprint(body()),
      state: "in_progress",
      status: null,
      body: null,
      createdAt: new Date().toISOString(),
      expiresAtMs: Date.now() + 60_000,
    });
    const res = await create(secret, body(), "key-3");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_in_progress");
    expect(res.headers.get("retry-after")).toBe("1");
  });

  it("scopes keys per merchant", async () => {
    const a = await newKeys("did:privy:a", "0x3333333333333333333333333333333333333333");
    const b = await newKeys("did:privy:b", "0x4444444444444444444444444444444444444444");
    const ra = await json(await create(a.secret, body(), "shared"));
    const rb = await json(await create(b.secret, body(), "shared"));
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.data.id).not.toBe(rb.body.data.id);
  });

  it("doesn't keep a key whose request failed validation", async () => {
    const { secret } = await newKeys();
    expect((await create(secret, body({ modes: [] }), "key-4")).status).toBe(400);
    expect((await create(secret, body(), "key-4")).status).toBe(201);
  });
});

describe("GET /api/v1/checkout/sessions/{id}", () => {
  it("returns the merchant's own session and hides everyone else's", async () => {
    const a = await newKeys("did:privy:a", "0x3333333333333333333333333333333333333333");
    const created = await json(await create(a.secret, body()));
    const id = created.body.data.id as string;
    const get = (secret: string, sid = id) => retrieveRoute(request("GET", `/api/v1/checkout/sessions/${sid}`, { headers: { authorization: `Bearer ${secret}` } }), params({ id: sid }));
    const mine = await json(await get(a.secret));
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual(created.body.data);
    const b = await newKeys("did:privy:b", "0x4444444444444444444444444444444444444444");
    expect((await get(b.secret)).status).toBe(404);
    expect((await get(a.secret, "cs_test_nope")).status).toBe(404);
  });

  it("reports an expired session as expired", async () => {
    const { secret } = await newKeys();
    const created = await json(await create(secret, body()));
    await getDb().sessions.update(created.body.data.id, (s) => ({ ...s, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const res = await json(await retrieveRoute(request("GET", "/x", { headers: { authorization: `Bearer ${secret}` } }), params({ id: created.body.data.id })));
    expect(res.body.data.status).toBe("expired");
  });
});

describe("GET /api/public/sessions/{id}", () => {
  it("gives the checkout what it signs, and no metadata", async () => {
    const { secret } = await newKeys();
    const created = await json(await create(secret, body()));
    const id = created.body.data.id as string;
    const res = await json(await publicGet(request("GET", `/api/public/sessions/${id}`), params({ id })));
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p).toMatchObject({
      id,
      status: "open",
      amount: "200.00",
      amountCents: 20000,
      modes: ["now", "later"],
      successUrl: `https://studio.example/thanks?session=${id}`,
      returnOrigin: "https://studio.example",
      chain: { chainId: 31337, orderId: "INV-2041", amountUnits: "200000000", merchant: MERCHANT_WALLET },
    });
    expect(p.payIn4).toMatchObject({ available: true, installments: 4, intervalSeconds: 604800, total: "201.534246", interest: "1.534246" });
    expect(p.payIn4.schedule.map((s: { amountUnits: string }) => s.amountUnits)).toEqual(["50383562", "50383561", "50383562", "50383561"]);
    expect(p).not.toHaveProperty("metadata");
  });

  it("says why Pay in 4 isn't offered", async () => {
    const env = setupServer();
    env.chain.reads.canOriginate = () => false;
    const { secret } = await newKeys();
    const created = await json(await create(secret, body()));
    const id = created.body.data.id as string;
    const p = (await json(await publicGet(request("GET", "/x"), params({ id })))).body.data;
    expect(p.payIn4).toMatchObject({ available: false, reason: "This business can't offer Pay in 4 for this amount yet." });
    const small = await json(await create(secret, body({ lineItems: [], amount: "5.00", orderId: "small" })));
    const q = (await json(await publicGet(request("GET", "/x"), params({ id: small.body.data.id })))).body.data;
    expect(q.payIn4.available).toBe(false);
  });

  it("is a 404 for an unknown or malformed id", async () => {
    expect((await publicGet(request("GET", "/x"), params({ id: "cs_test_unknown123" }))).status).toBe(404);
    expect((await publicGet(request("GET", "/x"), params({ id: "../etc" }))).status).toBe(404);
  });

  it("allows only the app's origins by CORS", async () => {
    const { secret } = await newKeys();
    const id = (await json(await create(secret, body()))).body.data.id as string;
    const allowed = await publicGet(request("GET", "/x", { headers: { origin: "http://localhost:3000" } }), params({ id }));
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const other = await publicGet(request("GET", "/x", { headers: { origin: "https://evil.example" } }), params({ id }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the real polarispay-sdk against these routes", () => {
  it("creates and retrieves a session through createPolarisServer", async () => {
    const { secret } = await newKeys();
    const inProcess: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const req = new Request(url, init as RequestInit);
      const match = /^\/api\/v1\/checkout\/sessions(?:\/([^/]+))?$/.exec(url.pathname);
      if (!match) return new Response("not found", { status: 404 });
      return match[1] ? retrieveRoute(req, params({ id: match[1] })) : createSessionRoute(req, params({}));
    };
    const polaris = createPolarisServer({ secretKey: secret, baseUrl: "http://localhost:3100", fetch: inProcess, maxRetries: 0 });
    const session = await polaris.checkout.sessions.create(
      { amount: "200.00", description: "Brand identity package", modes: ["now", "later"], successUrl: "https://studio.example/thanks", orderId: "INV-7" },
      { idempotencyKey: "INV-7" },
    );
    expect(session.status).toBe("open");
    expect(session.url).toBe(`http://localhost:3000/pay/${session.id}`);
    const again = await polaris.checkout.sessions.create(
      { amount: "200.00", description: "Brand identity package", modes: ["now", "later"], successUrl: "https://studio.example/thanks", orderId: "INV-7" },
      { idempotencyKey: "INV-7" },
    );
    expect(again.id).toBe(session.id);
    const read = await polaris.checkout.sessions.retrieve(session.id);
    expect(read.id).toBe(session.id);
    await expect(
      polaris.checkout.sessions.create(
        { amount: "201.00", description: "Brand identity package", successUrl: "https://studio.example/thanks", orderId: "INV-7" },
        { idempotencyKey: "INV-7" },
      ),
    ).rejects.toMatchObject({ type: "idempotency_error", code: "idempotency_key_reused" });
  });
});
