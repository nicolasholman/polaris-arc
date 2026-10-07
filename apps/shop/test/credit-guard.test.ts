import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creditGuard, resetCreditGuardCache } from "@/lib/polaris";
import { pausedMessage } from "@/lib/polaris-config";

/**
 * Halcyon reads Polaris's risk guard (polarispay-sdk `credit.guard()`, GET
 * /api/public/credit-guard) when it serves a page: while it has paused new
 * Pay in 4 plans, the product line, the bag, the home band and the checkout
 * say "Pay in 4 is paused by our risk guard; pay now works as usual." and
 * offer Pay now. An API that doesn't answer never holds a page up, and reads
 * as open (the hosted checkout and the chain still apply the real answer).
 */

const API = "http://localhost:3100";
const PAUSED = {
  state: "paused",
  paused: true,
  reasons: ["depeg"],
  message: "Pay in 4 is paused by our risk guard; pay now works as usual.",
  checkedAt: "2026-10-02T12:00:00.000Z",
  ageSeconds: 42,
  readAt: "2026-10-02T12:00:42.000Z",
};

function backend() {
  vi.stubEnv("POLARIS_API_BASE", API);
  vi.stubEnv("POLARIS_SECRET_KEY", "sk_test_51Hx8yQfT3sLk2PzR9vWc");
  vi.stubEnv("POLARIS_WEBHOOK_SECRET", "whsec_test");
  vi.stubEnv("NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY", "pk_test_51Hx8yQfT3sLk2PzR9vWc");
  vi.stubEnv("NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN", "http://localhost:3000");
  vi.stubEnv("POLARIS_MERCHANT_ADDRESS", "0x4a1c000000000000000000000000000000000000");
}

beforeEach(() => resetCreditGuardCache());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the risk guard in the store", () => {
  it("reads GET /api/public/credit-guard through the SDK, once per 10 s", async () => {
    backend();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: PAUSED }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const guard = await creditGuard();
    expect(guard).toEqual({ paused: true, message: PAUSED.message, state: "paused" });
    expect(pausedMessage(guard)).toBe("Pay in 4 is paused by our risk guard; pay now works as usual.");
    await creditGuard();
    expect(calls).toEqual([`${API}/api/public/credit-guard`]);
  });

  it("reads as open when the API errors or doesn't answer in time, and with payments off", async () => {
    backend();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), { status: 400 }));
    expect(await creditGuard()).toBeNull();
    expect(pausedMessage(null)).toBeNull();

    resetCreditGuardCache();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    const slow = creditGuard();
    await vi.advanceTimersByTimeAsync(2_600);
    expect(await slow).toBeNull();
    vi.useRealTimers();

    resetCreditGuardCache();
    vi.unstubAllEnvs();
    vi.stubEnv("POLARIS_API_BASE", "");
    expect(await creditGuard()).toBeNull();
  });

  it("offers Pay in 4 as usual while the guard is open or late", () => {
    expect(pausedMessage({ paused: false, message: null, state: "open" })).toBeNull();
    expect(pausedMessage({ paused: false, message: null, state: "stale" })).toBeNull();
    expect(pausedMessage({ paused: true, message: null, state: "paused" })).toBe("Pay in 4 is paused by our risk guard; pay now works as usual.");
  });
});
