import { afterEach, describe, expect, it, vi } from "vitest";

import { browserConfig, resolvePolarisConfig } from "@/lib/polaris";

/**
 * The shop's Polaris settings. Payments go through Polaris for Business or
 * not at all: a missing setting means "not configured", with the reason, in
 * every environment, and nothing stands in for the API.
 */

const MERCHANT = "0x4a1c000000000000000000000000000000000000";
const BACKEND = {
  POLARIS_API_BASE: "http://localhost:3100/",
  POLARIS_SECRET_KEY: "sk_test_topsecret123",
  POLARIS_WEBHOOK_SECRET: "whsec_topsecret",
  NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY: "pk_test_public12345",
  NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN: "http://localhost:3000/pay",
  POLARIS_MERCHANT_ADDRESS: MERCHANT,
};

afterEach(() => vi.unstubAllEnvs());

describe("resolvePolarisConfig", () => {
  it("is not configured without POLARIS_API_BASE, in development as in production", () => {
    for (const NODE_ENV of ["development", "production", "test"]) {
      const config = resolvePolarisConfig({ NODE_ENV });
      expect(config.ok).toBe(false);
      expect(!config.ok && config.reason).toMatch(/^Set POLARIS_API_BASE, POLARIS_SECRET_KEY, /);
    }
  });

  it("demands every key once POLARIS_API_BASE is set", () => {
    const partial = resolvePolarisConfig({ NODE_ENV: "development", POLARIS_API_BASE: "http://localhost:3100" });
    expect(partial.ok).toBe(false);
    expect(!partial.ok && partial.reason).toMatch(/POLARIS_SECRET_KEY/);
    expect(!partial.ok && partial.reason).not.toMatch(/POLARIS_API_BASE/);
  });

  it("demands SHOP_URL in production", () => {
    const config = resolvePolarisConfig({ ...BACKEND, NODE_ENV: "production" });
    expect(!config.ok && config.reason).toBe("Set SHOP_URL to take payments through Polaris.");
  });

  it("refuses settings that aren't URLs or an address, instead of throwing", () => {
    expect(resolvePolarisConfig({ ...BACKEND, POLARIS_API_BASE: "localhost:3100" })).toEqual({ ok: false, reason: "POLARIS_API_BASE must be an http(s) URL." });
    expect(resolvePolarisConfig({ ...BACKEND, NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN: "not a url" })).toEqual({
      ok: false,
      reason: "NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN must be an http(s) URL.",
    });
    expect(resolvePolarisConfig({ ...BACKEND, POLARIS_MERCHANT_ADDRESS: "0x123" })).toMatchObject({ ok: false });
  });

  it("points at Polaris for Business with the store's own keys", () => {
    expect(resolvePolarisConfig({ ...BACKEND, NODE_ENV: "development" })).toEqual({
      ok: true,
      baseUrl: "http://localhost:3100",
      secretKey: "sk_test_topsecret123",
      webhookSecret: "whsec_topsecret",
      publishableKey: "pk_test_public12345",
      checkoutOrigin: "http://localhost:3000",
      relayUrl: "http://localhost:3100/api/v1/relay/payments",
      merchant: MERCHANT,
    });
  });
});

describe("browserConfig", () => {
  it("gives the browser no secrets", () => {
    for (const [name, value] of Object.entries(BACKEND)) vi.stubEnv(name, value);
    const config = browserConfig();
    expect(config).toMatchObject({ ok: true, publishableKey: "pk_test_public12345", checkoutOrigin: "http://localhost:3000" });
    const text = JSON.stringify(config);
    expect(text).not.toContain("sk_test");
    expect(text).not.toContain("whsec");
  });

  it("tells the checkout why payments aren't configured", () => {
    vi.stubEnv("POLARIS_API_BASE", "");
    const config = browserConfig();
    expect(config).toMatchObject({ ok: false, reason: expect.stringContaining("POLARIS_API_BASE"), payInFourAprBps: 1000 });
  });
});
