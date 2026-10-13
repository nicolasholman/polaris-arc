import { describe, expect, it, vi, afterEach } from "vitest";
import { merchantSetup } from "../src/lib/merchant-setup";
import type { Merchant, Payment, PaymentLink } from "../src/lib/data/types";
const merchant = { id: "m", businessName: "Shop", walletAddress: null, email: null, createdAt: "2026-10-08", registration: { state: "none", txHash: null, activationTxHash: null, error: null } } satisfies Merchant;
const link = { id: "l", url: "https://pay.example/pay/l", amountCents: 100, description: "Order", modes: ["now"], usage: "reusable", expiresAt: null, status: "active", paymentsCount: 0, collectedCents: 0, createdAt: "2026-10-08" } satisfies PaymentLink;
afterEach(() => vi.useRealTimers());
describe("merchant setup progress", () => {
  it("never completes steps whose data has not loaded", () => {
    const setup = merchantSetup(merchant, undefined, undefined);
    expect(setup.steps.map((s) => s.done)).toEqual([false, null, null]);
    expect(setup.complete).toBe(false);
    expect(setup.current).toBe("registration");
  });
  it("a submitted or failed registration remains incomplete; registered accepts Pay now", () => {
    for (const state of ["none", "submitted", "failed"] as const) expect(merchantSetup({ ...merchant, registration: { ...merchant.registration, state } }, [], []).current).toBe("registration");
    expect(merchantSetup({ ...merchant, registration: { ...merchant.registration, state: "registered" } }, [], []).current).toBe("link");
  });
  it("only offers usable links, never expired, inactive or already-used ones", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08"));
    const setup = merchantSetup(merchant, [{ ...link, status: "inactive" }, { ...link, status: "used" }, { ...link, expiresAt: "2026-10-07" }, link], []);
    expect(setup.usableLink).toBe(link);
    expect(setup.steps[1]?.done).toBe(true);
  });
  it("requires a succeeded persisted payment; failed payments never finish onboarding", () => {
    const registered = { ...merchant, registration: { ...merchant.registration, state: "active" as const } };
    expect(merchantSetup(registered, [link], [{ status: "failed" } as Payment]).current).toBe("payment");
    expect(merchantSetup(registered, [], [{ status: "succeeded" } as Payment]).complete).toBe(true);
  });
});
