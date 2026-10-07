import { quotePayIn4 } from "polarispay-sdk";
import { describe, expect, it } from "vitest";

import { payIn4, weekLabel } from "@/lib/pay-in-4";
import { payInFourApr } from "@/lib/polaris";

describe("Pay in 4 pricing the store advertises", () => {
  it("is the loan engine's 10% APR by default: $200 is 4 × $50.38", () => {
    expect(payInFourApr({})).toBe(1000);
    const quote = quotePayIn4("200.00", { aprBps: payInFourApr({}) });
    expect(quote.each).toBe("50.38");
    expect(quote.interest).toBe("1.53");
    expect(quote.interestFree).toBe(false);
  });

  it("quotes Halcyon One as 4 × $87.92: $2.68 of interest, $351.68 in total, nothing due today", () => {
    const plan = payIn4(34900, payInFourApr({}))!;
    expect(plan).toMatchObject({ each: 8792, interest: 268, total: 35168, aprBps: 1000 });
    expect(plan.installments.map((i) => i.amount)).toEqual([8792, 8792, 8792, 8792]);
    // PolarisLoanEngine.installmentDueAt(i) = startedAt + (i + 1) x interval.
    expect(plan.installments.map((i) => i.dueInSeconds)).toEqual([1, 2, 3, 4].map((w) => w * 604_800));
    expect(plan.installments.map((i) => weekLabel(i.dueInSeconds))).toEqual(["Week 1", "Week 2", "Week 3", "Week 4"]);
  });

  it("keeps the rows adding up to the total: $899 is 4 × $226.47", () => {
    const plan = payIn4(89900, 1000)!;
    expect(plan.each).toBe(22647);
    expect(plan.interest).toBe(690);
    expect(plan.installments.reduce((n, i) => n + i.amount, 0)).toBe(plan.total);
  });

  it("never quotes an interest-free plan: the loan engine has one rate", () => {
    const quote = quotePayIn4("349.00", { aprBps: payInFourApr({ POLARIS_PAY_IN_4_APR_BPS: "0" }) });
    expect(quote.aprBps).toBe(1000);
    expect(quote.each).toBe("87.92");
    expect(quote.interest).toBe("2.68");
  });

  it("falls back to the loan engine's rate on a nonsense setting", () => {
    expect(payInFourApr({ POLARIS_PAY_IN_4_APR_BPS: "lots" })).toBe(1000);
    expect(payInFourApr({ POLARIS_PAY_IN_4_APR_BPS: "20000" })).toBe(1000);
    expect(payInFourApr({ POLARIS_PAY_IN_4_APR_BPS: "" })).toBe(1000);
  });
});
