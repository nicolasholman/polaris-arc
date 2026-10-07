import { signWebhookPayload } from "polarispay-sdk/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PolarisSignatureVerificationError, verifyWebhook } from "@/lib/polaris";

import { SECRET, TX, ADDR, event, signed } from "./helpers";

const body = JSON.stringify(
  event("payment.succeeded", {
    txHash: TX,
    chainId: 10143,
    orderId: "hc_x",
    sessionId: "cs_test_1",
    metadata: {},
    paymentId: TX,
    mode: "now",
    merchant: ADDR,
    payer: ADDR,
    amount: "349.00",
    fee: "1.745",
    currency: "USD",
  }),
);

beforeEach(() => {
  vi.stubEnv("POLARIS_API_BASE", "https://api.polaris.test");
  vi.stubEnv("POLARIS_SECRET_KEY", "sk_test_shopsecret123");
  vi.stubEnv("POLARIS_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY", "pk_test_shoppublic123");
  vi.stubEnv("NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN", "https://pay.polaris.test");
  vi.stubEnv("POLARIS_MERCHANT_ADDRESS", "0x1111111111111111111111111111111111111111");
});
afterEach(() => vi.unstubAllEnvs());

function reason(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof PolarisSignatureVerificationError ? e.reason : `unexpected: ${(e as Error).message}`;
  }
}

/** The store's verify: polaris.webhooks.verify with the configured secret. */
const verify = (raw: string, header: string | null, now?: number) => verifyWebhook(raw, header, now);

describe("webhook verification (polaris.webhooks.verify, through the store's config)", () => {
  it("accepts a delivery signed with the endpoint's secret, and returns the event", () => {
    const parsed = verify(body, signed(body));
    expect(parsed.type).toBe("payment.succeeded");
    expect(parsed.data).toMatchObject({ orderId: "hc_x", amount: "349.00" });
  });

  it("rejects a tampered body", () => {
    expect(reason(() => verify(body.replace('"349.00"', '"1.00"'), signed(body)))).toBe("signature_mismatch");
  });

  it("rejects a signature made with another secret", () => {
    expect(reason(() => verify(body, signed(body, "whsec_someone_else")))).toBe("signature_mismatch");
  });

  it("rejects a stale delivery outside the five-minute window: a captured request replayed later", () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    expect(reason(() => verify(body, signed(body, SECRET, old)))).toBe("timestamp_outside_tolerance");
  });

  it("rejects a timestamp from the future too", () => {
    const future = Math.floor(Date.now() / 1000) + 400;
    expect(reason(() => verify(body, signed(body, SECRET, future)))).toBe("timestamp_outside_tolerance");
  });

  it("can't be rescued by re-stamping a captured signature with a fresh timestamp", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const v1 = signWebhookPayload(body, SECRET, old).split("v1=")[1];
    const now = Math.floor(Date.now() / 1000);
    expect(reason(() => verify(body, `t=${now},v1=${v1}`))).toBe("signature_mismatch");
  });

  it("rejects a missing or malformed header", () => {
    expect(reason(() => verify(body, null))).toBe("missing_header");
    expect(reason(() => verify(body, `v1=${"a".repeat(64)}`))).toBe("malformed_header");
    expect(reason(() => verify(body, `t=${Math.floor(Date.now() / 1000)}`))).toBe("no_signatures");
  });

  it("accepts any matching v1 while a secret is being rolled", () => {
    const t = Math.floor(Date.now() / 1000);
    const oldSig = signWebhookPayload(body, "whsec_old", t).split("v1=")[1];
    const newSig = signWebhookPayload(body, SECRET, t).split("v1=")[1];
    expect(verify(body, `t=${t},v1=${oldSig},v1=${newSig}`).id).toBeTruthy();
  });

  it("rejects a signed body that isn't a Polaris event", () => {
    const junk = JSON.stringify({ hello: "world" });
    expect(reason(() => verify(junk, signed(junk)))).toBe("invalid_payload");
    expect(reason(() => verify("not json", signed("not json")))).toBe("invalid_payload");
  });
});
