import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  assertDeliverableUrl,
  deliverWebhook,
  isPrivateAddress,
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptAt,
  serializeEvent,
  signWebhookBody,
  verifyWebhookSignature,
  type WebhookEnvelope,
} from "../src/webhooks.ts";
import { canonicalJson, hashSecretKey, keyHint, newPublishableKey, newSecretKey, newWebhookSecret, parseApiKey } from "../src/keys.ts";

const event: WebhookEnvelope = {
  id: "evt_test",
  object: "event",
  type: "payment.succeeded",
  createdAt: "2026-10-01T12:00:00.000Z",
  livemode: false,
  merchantId: "mer_1",
  data: { orderId: "o_1", amount: "25.00" },
};

describe("signatures", () => {
  it("signs t.body with the whole whsec_ string and verifies", () => {
    const secret = newWebhookSecret();
    const body = serializeEvent(event);
    const header = signWebhookBody(secret, body, 1_790_000_000);
    expect(header).toMatch(/^t=1790000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, header, { nowSeconds: 1_790_000_010 })).toEqual({ ok: true, timestamp: 1_790_000_000 });
  });

  it("refuses a tampered body, a wrong secret, an old timestamp and a missing header", () => {
    const secret = "whsec_abc";
    const body = serializeEvent(event);
    const header = signWebhookBody(secret, body, 1_000);
    expect(verifyWebhookSignature(secret, `${body} `, header, { nowSeconds: 1_000 })).toMatchObject({ reason: "signature_mismatch" });
    expect(verifyWebhookSignature("whsec_other", body, header, { nowSeconds: 1_000 })).toMatchObject({ reason: "signature_mismatch" });
    expect(verifyWebhookSignature(secret, body, header, { nowSeconds: 1_301 })).toMatchObject({ reason: "timestamp_outside_tolerance" });
    expect(verifyWebhookSignature(secret, body, null)).toMatchObject({ reason: "missing_header" });
    expect(verifyWebhookSignature(secret, body, "v1=00", { nowSeconds: 1_000 })).toMatchObject({ reason: "malformed_header" });
  });

  it("accepts any one of several v1 values (secret rotation)", () => {
    const body = serializeEvent(event);
    const oldH = signWebhookBody("whsec_old", body, 5);
    const newH = signWebhookBody("whsec_new", body, 5);
    const both = `t=5,${oldH.split(",")[1]},${newH.split(",")[1]}`;
    expect(verifyWebhookSignature("whsec_new", body, both, { nowSeconds: 5 }).ok).toBe(true);
  });

  it("serialises the envelope with a fixed key order", () => {
    const shuffled = { data: event.data, merchantId: "mer_1", type: event.type, id: event.id, object: "event", livemode: false, createdAt: event.createdAt } as WebhookEnvelope;
    expect(serializeEvent(shuffled)).toBe(serializeEvent(event));
    expect(Object.keys(JSON.parse(serializeEvent(event)))).toEqual(["id", "object", "type", "createdAt", "livemode", "merchantId", "data"]);
  });
});

describe("retry schedule", () => {
  it("backs off, then gives up after the last attempt", () => {
    const now = 1_000_000;
    expect(nextAttemptAt(1, now, 0)).toBe(now + 60_000);
    expect(nextAttemptAt(2, now, 0)).toBe(now + 300_000);
    expect(nextAttemptAt(1, now, 1)).toBe(now + 66_000);
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS - 1, now, 0)).not.toBeNull();
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS, now, 0)).toBeNull();
  });
});

describe("SSRF guard", () => {
  it("classifies private and public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "100.64.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "172.32.0.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses http, credentials and private hosts unless development allows them", () => {
    expect(() => assertDeliverableUrl("http://example.com/hook")).toThrow(/https/);
    expect(() => assertDeliverableUrl("https://user:pw@example.com/hook")).toThrow(/credentials/);
    expect(() => assertDeliverableUrl("https://127.0.0.1/hook")).toThrow(/public internet/);
    expect(() => assertDeliverableUrl("https://localhost/hook")).toThrow(/public internet/);
    expect(assertDeliverableUrl("https://example.com/hook").host).toBe("example.com");
    expect(assertDeliverableUrl("http://localhost:3531/hook", { allowPrivate: true }).port).toBe("3531");
    expect(() => assertDeliverableUrl("ftp://example.com")).toThrow(/https/);
  });
});

describe("deliverWebhook", () => {
  it("sends the SDK's headers and a verifiable signature", async () => {
    const secret = newWebhookSecret();
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const body = serializeEvent(event);
      const out = await deliverWebhook({ url: `http://127.0.0.1:${port}/hook`, secret, eventType: "payment.succeeded", body, attempt: 2, allowPrivate: true });
      expect(out).toMatchObject({ ok: true, status: 204, error: null });
      const got = received[0];
      expect(got?.body).toBe(body);
      expect(got?.headers["content-type"]).toBe("application/json");
      expect(got?.headers["polaris-event"]).toBe("payment.succeeded");
      expect(got?.headers["polaris-delivery-attempt"]).toBe("2");
      expect(verifyWebhookSignature(secret, body, got?.headers["polaris-signature"] as string).ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("refuses a private address at connect time without allowPrivate", async () => {
    const out = await deliverWebhook({
      url: "https://localhost.test.invalid/hook",
      secret: "whsec_x",
      eventType: "payment.succeeded",
      body: "{}",
      attempt: 1,
      transport: async () => {
        throw Object.assign(new Error("refused"), { code: "EPRIVATE" });
      },
    });
    expect(out).toMatchObject({ ok: false, retryable: false });
    const guarded = await deliverWebhook({ url: "http://127.0.0.1:1/hook", secret: "whsec_x", eventType: "payment.succeeded", body: "{}", attempt: 1 });
    expect(guarded).toMatchObject({ ok: false, retryable: false, status: null });
  });

  it("marks a 500 and a network failure retryable", async () => {
    const five = await deliverWebhook({ url: "https://example.com/h", secret: "whsec_x", eventType: "plan.opened", body: "{}", attempt: 1, transport: async () => ({ status: 500, body: "boom" }) });
    expect(five).toMatchObject({ ok: false, status: 500, retryable: true, responseBody: "boom" });
    const net = await deliverWebhook({
      url: "https://example.com/h",
      secret: "whsec_x",
      eventType: "plan.opened",
      body: "{}",
      attempt: 1,
      transport: async () => {
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
    });
    expect(net).toMatchObject({ ok: false, status: null, retryable: true });
    expect(net.error).toMatch(/ECONNRESET/);
  });

  // The reported stall: 1 KB every 500 ms held a 2 s delivery for 8 s, and the body was read to the end.
  it("bounds the whole attempt by timeoutMs, however slowly the endpoint trickles its answer", async () => {
    const timers: NodeJS.Timeout[] = [];
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x");
      const t = setInterval(() => res.write("x"), 100);
      timers.push(t);
      setTimeout(() => {
        clearInterval(t);
        res.end();
      }, 8_000).unref();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const started = Date.now();
      const out = await deliverWebhook({ url: `http://127.0.0.1:${port}/hook`, secret: "whsec_x", eventType: "payment.succeeded", body: "{}", attempt: 1, allowPrivate: true, timeoutMs: 700 });
      const took = Date.now() - started;
      expect(out).toMatchObject({ ok: false, status: null, retryable: true });
      expect(out.error).toMatch(/ETIMEDOUT/);
      expect(took).toBeLessThan(2_000);
    } finally {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections();
      server.close();
    }
  }, 10_000);

  it("stops reading a response once it has the 2 KB it keeps", async () => {
    let wrote = 0;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = "y".repeat(1024);
      const t = setInterval(() => {
        if (!res.write(chunk)) return;
        wrote += chunk.length;
      }, 20);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const started = Date.now();
      const out = await deliverWebhook({ url: `http://127.0.0.1:${port}/hook`, secret: "whsec_x", eventType: "payment.succeeded", body: "{}", attempt: 1, allowPrivate: true, timeoutMs: 5_000 });
      expect(out).toMatchObject({ ok: true, status: 200 });
      expect(out.responseBody).toHaveLength(2048);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(wrote).toBeLessThan(64 * 1024);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 10_000);
});

describe("keys", () => {
  it("generates keys of the documented shapes and parses them", () => {
    const sk = newSecretKey();
    const pk = newPublishableKey();
    expect(sk).toMatch(/^sk_test_[0-9A-Za-z]{40}$/);
    expect(pk).toMatch(/^pk_test_[0-9A-Za-z]{24}$/);
    expect(parseApiKey(sk)).toEqual({ kind: "secret", mode: "test" });
    expect(parseApiKey(pk)).toEqual({ kind: "publishable", mode: "test" });
    expect(parseApiKey("sk_test_short")).toBeNull();
    expect(parseApiKey("Bearer sk_test_x")).toBeNull();
    expect(keyHint(sk)).toBe(`sk_test_…${sk.slice(-4)}`);
    expect(keyHint("whsec_abcdef")).toBe("whsec_…cdef");
  });

  it("hashes with the pepper, and differently without it", () => {
    const sk = newSecretKey();
    const a = hashSecretKey(sk, "pepper-1");
    expect(a).toMatch(/^hmac256:[0-9a-f]{64}$/);
    expect(hashSecretKey(sk, "pepper-1")).toBe(a);
    expect(hashSecretKey(sk, "pepper-2")).not.toBe(a);
    expect(hashSecretKey(sk, undefined)).toMatch(/^sha256:/);
  });

  it("fingerprints JSON independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
