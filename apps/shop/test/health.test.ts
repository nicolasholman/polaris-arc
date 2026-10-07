import { describe, expect, it } from "vitest";

import { shopHealth } from "@/lib/health";

/** GET /api/health: how the store is wired to Polaris, for scripts/deploy-check.mjs, without a secret in it. */

const BACKEND = {
  NODE_ENV: "production",
  POLARIS_API_BASE: "https://business.example/",
  POLARIS_SECRET_KEY: "sk_test_secretsecret",
  POLARIS_WEBHOOK_SECRET: "whsec_secretsecret",
  NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY: "pk_test_publishable",
  NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN: "https://app.example/pay",
  POLARIS_MERCHANT_ADDRESS: "0xA2672c1BaD9aAa4F1408929C677d58EC0E1aC185",
  SHOP_URL: "https://shop.example/",
  VERCEL: "1",
  KV_REST_API_URL: "https://x.upstash.io",
  KV_REST_API_TOKEN: "kv-secret",
};

describe("shopHealth", () => {
  it("reports the API, checkout and relay it pays through, and where orders live", () => {
    const health = shopHealth(BACKEND);
    expect(health).toEqual({
      ok: true,
      service: "halcyon-shop",
      production: true,
      polaris: {
        configured: true,
        apiBase: "https://business.example",
        checkoutOrigin: "https://app.example",
        relayUrl: "https://business.example/api/v1/relay/payments",
        merchant: "0xA2672c1BaD9aAa4F1408929C677d58EC0E1aC185",
        publishableKeyMode: "test",
      },
      shopUrl: "https://shop.example",
      orderStore: { kind: "redis", serverless: true },
    });
  });

  it("never echoes a secret", () => {
    const text = JSON.stringify(shopHealth(BACKEND));
    for (const secret of ["sk_test_secretsecret", "whsec_secretsecret", "kv-secret", "pk_test_publishable"]) expect(text).not.toContain(secret);
  });

  it("says why payments are off when a setting is missing", () => {
    const health = shopHealth({ ...BACKEND, SHOP_URL: undefined });
    expect(health.polaris).toEqual({ configured: false, reason: expect.stringContaining("SHOP_URL") });
    expect(health.shopUrl).toBeNull();
  });

  it("reports payments as not configured without Polaris settings, in development too", () => {
    for (const NODE_ENV of ["development", "production"]) {
      const health = shopHealth({ NODE_ENV });
      expect(health.polaris).toEqual({ configured: false, reason: expect.stringContaining("POLARIS_API_BASE") });
    }
  });
});
