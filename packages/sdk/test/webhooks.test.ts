import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { PolarisSignatureVerificationError } from "../src/errors.js";
import { WEBHOOK_EVENT_TYPES } from "../src/events.js";
import { __setNodeCryptoForTests } from "../src/server/hmac.js";
import {
  WEBHOOK_TOLERANCE_SECONDS,
  generateTestHeader,
  signWebhookPayload,
  verifyWebhook,
  verifyWebhookAsync,
} from "../src/server/webhooks.js";

const SECRET = "whsec_4mGq9vT2kLwP8xYz3bNc6RfD";
const NOW = 1_790_426_298;

const event = {
  id: "evt_1a2b3c4d5e6f",
  object: "event",
  type: "payment.succeeded",
  createdAt: "2026-09-26T12:38:18.000Z",
  livemode: false,
  merchantId: "mer_studio_sol",
  data: {
    orderId: "INV-2041",
    sessionId: "cs_test_a1B2c3D4e5F6g7H8",
    metadata: { invoice: "2041" },
    paymentId: "0x3f1c2f0c6b4c6d5a3a3e8b8a1d0c9e7f5a6b4c3d2e1f0a9b8c7d6e5f4a3b2c1d",
    mode: "now",
    merchant: "0x1111111111111111111111111111111111111111",
    payer: "0x2222222222222222222222222222222222222222",
    amount: "200.00",
    fee: "1.00",
    currency: "USD",
    txHash: "0xabababababababababababababababababababababababababababababababab",
    chainId: 10143,
  },
};
const body = JSON.stringify(event);

/** What apps/business and packages/db sign with: createHmac over `${t}.${body}`. */
function signLikeTheBackend(secret: string, payload: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PolarisSignatureVerificationError);
    return (err as PolarisSignatureVerificationError).reason;
  }
  return undefined;
}

afterEach(() => __setNodeCryptoForTests(undefined));

describe("webhooks.verify", () => {
  it("accepts a delivery signed exactly as the backend signs it", () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    const verified = verifyWebhook(body, header, SECRET, { now: NOW + 5 });
    expect(verified).toEqual(event);
    expect(verified.type).toBe("payment.succeeded");
    if (verified.type === "payment.succeeded") expect(verified.data.orderId).toBe("INV-2041");
  });

  it("accepts a Buffer body and a header array (Node's IncomingHttpHeaders)", () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    expect(verifyWebhook(Buffer.from(body, "utf8"), [header], SECRET, { now: NOW }).id).toBe(event.id);
  });

  it("rejects a tampered body", () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    const tampered = body.replace('"amount":"200.00"', '"amount":"2000.00"');
    expect(tampered).not.toBe(body);
    expect(reason(() => verifyWebhook(tampered, header, SECRET, { now: NOW }))).toBe("signature_mismatch");
  });

  it("rejects a tampered signature, and a tampered timestamp", () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    const flipped = header.replace(/v1=(.)/, (_m, c: string) => `v1=${c === "a" ? "b" : "a"}`);
    expect(reason(() => verifyWebhook(body, flipped, SECRET, { now: NOW }))).toBe("signature_mismatch");
    const moved = header.replace(`t=${NOW}`, `t=${NOW + 1}`);
    expect(reason(() => verifyWebhook(body, moved, SECRET, { now: NOW }))).toBe("signature_mismatch");
  });

  it("rejects the wrong secret", () => {
    const header = signLikeTheBackend("whsec_someone_else", body, NOW);
    expect(reason(() => verifyWebhook(body, header, SECRET, { now: NOW }))).toBe("signature_mismatch");
  });

  it("rejects a stale delivery: a valid signature replayed after the tolerance window", () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    expect(reason(() => verifyWebhook(body, header, SECRET, { now: NOW + WEBHOOK_TOLERANCE_SECONDS + 1 }))).toBe(
      "timestamp_outside_tolerance",
    );
    // Inside the window it's fine, both ways.
    expect(verifyWebhook(body, header, SECRET, { now: NOW + WEBHOOK_TOLERANCE_SECONDS }).id).toBe(event.id);
    expect(verifyWebhook(body, header, SECRET, { now: NOW - WEBHOOK_TOLERANCE_SECONDS }).id).toBe(event.id);
  });

  it("rejects a timestamp from the future", () => {
    const header = signLikeTheBackend(SECRET, body, NOW + 3600);
    expect(reason(() => verifyWebhook(body, header, SECRET, { now: NOW }))).toBe("timestamp_outside_tolerance");
  });

  it("uses the real clock by default", () => {
    const fresh = Math.floor(Date.now() / 1000);
    expect(verifyWebhook(body, signLikeTheBackend(SECRET, body, fresh), SECRET).id).toBe(event.id);
    expect(reason(() => verifyWebhook(body, signLikeTheBackend(SECRET, body, fresh - 3600), SECRET))).toBe(
      "timestamp_outside_tolerance",
    );
  });

  it("honours a custom tolerance", () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    expect(reason(() => verifyWebhook(body, header, SECRET, { now: NOW + 11, toleranceSeconds: 10 }))).toBe(
      "timestamp_outside_tolerance",
    );
  });

  it("names what's wrong with a missing or malformed header", () => {
    expect(reason(() => verifyWebhook(body, undefined, SECRET))).toBe("missing_header");
    expect(reason(() => verifyWebhook(body, "", SECRET))).toBe("missing_header");
    expect(reason(() => verifyWebhook(body, "v1=abc", SECRET))).toBe("malformed_header");
    expect(reason(() => verifyWebhook(body, `t=${NOW}`, SECRET))).toBe("no_signatures");
    expect(reason(() => verifyWebhook(body, `t=${NOW},v1=nothex`, SECRET))).toBe("no_signatures");
    expect(reason(() => verifyWebhook(body, signLikeTheBackend(SECRET, body, NOW), ""))).toBe("missing_secret");
  });

  it("accepts any matching v1 while a secret is rotated", () => {
    const current = signLikeTheBackend(SECRET, body, NOW).split(",")[1]!;
    const old = signLikeTheBackend("whsec_old", body, NOW).split(",")[1]!;
    expect(verifyWebhook(body, `t=${NOW},${old},${current}`, SECRET, { now: NOW }).id).toBe(event.id);
  });

  it("refuses a parsed object: the raw body is what was signed", () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    expect(reason(() => verifyWebhook(JSON.parse(body) as never, header, SECRET, { now: NOW }))).toBe("invalid_payload");
  });

  it("refuses a verified body that isn't an event", () => {
    const junk = "not json";
    expect(reason(() => verifyWebhook(junk, signLikeTheBackend(SECRET, junk, NOW), SECRET, { now: NOW }))).toBe("invalid_payload");
    const noType = JSON.stringify({ id: "evt_1" });
    expect(reason(() => verifyWebhook(noType, signLikeTheBackend(SECRET, noType, NOW), SECRET, { now: NOW }))).toBe(
      "invalid_payload",
    );
  });

  it("normalises the first dashboard build's test event (eventId/event)", () => {
    const legacy = JSON.stringify({
      eventId: "evt_legacy",
      event: "payment.succeeded",
      createdAt: "2026-09-26T12:00:00.000Z",
      merchantId: "mer_1",
      livemode: false,
      test: true,
      data: { orderId: "ord_test_1", amount: "200.00", currency: "USD", mode: "now" },
    });
    const verified = verifyWebhook(legacy, signLikeTheBackend(SECRET, legacy, NOW), SECRET, { now: NOW });
    expect(verified).toMatchObject({ id: "evt_legacy", object: "event", type: "payment.succeeded", livemode: false, merchantId: "mer_1" });
    expect(verified).not.toHaveProperty("eventId");
    expect(verified).not.toHaveProperty("event");
  });

  it("works on the pure-JS path too (edge runtimes, older Node)", () => {
    __setNodeCryptoForTests(null);
    const header = signLikeTheBackend(SECRET, body, NOW);
    expect(verifyWebhook(body, header, SECRET, { now: NOW }).id).toBe(event.id);
    expect(reason(() => verifyWebhook(`${body} `, header, SECRET, { now: NOW }))).toBe("signature_mismatch");
  });

  it("verifyAsync (Web Crypto) agrees", async () => {
    const header = signLikeTheBackend(SECRET, body, NOW);
    await expect(verifyWebhookAsync(body, header, SECRET, { now: NOW })).resolves.toEqual(event);
    await expect(verifyWebhookAsync(`${body}x`, header, SECRET, { now: NOW })).rejects.toMatchObject({ reason: "signature_mismatch" });
    await expect(verifyWebhookAsync(body, header, SECRET, { now: NOW + 301 })).rejects.toMatchObject({
      reason: "timestamp_outside_tolerance",
    });
  });

  it("signs test headers a handler will accept, byte-identical to the backend's", () => {
    expect(signWebhookPayload(body, SECRET, NOW)).toBe(signLikeTheBackend(SECRET, body, NOW));
    const header = generateTestHeader({ payload: body, secret: SECRET, timestamp: NOW });
    expect(verifyWebhook(body, header, SECRET, { now: NOW }).id).toBe(event.id);
  });

  it("lists exactly the plan's nine event types", () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([
      "payment.succeeded",
      "plan.opened",
      "installment.collected",
      "installment.failed",
      "plan.completed",
      "plan.liquidated",
      "subscription.charged",
      "subscription.canceled",
      "payout.paid",
    ]);
  });
});
