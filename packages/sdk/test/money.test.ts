import { describe, expect, it } from "vitest";

import { PAY_IN_4, formatBaseUnits, formatUsd, formatUsdAmount, normaliseAmount, quotePayIn4, toBaseUnits, toCents } from "../src/money.js";

describe("amounts", () => {
  it("canonicalises decimal strings and exact numbers", () => {
    expect(normaliseAmount("200")).toBe("200.00");
    expect(normaliseAmount("200.5")).toBe("200.50");
    expect(normaliseAmount(" 19.99 ")).toBe("19.99");
    expect(normaliseAmount(200.5)).toBe("200.50");
  });

  it("refuses anything that isn't a positive whole number of cents", () => {
    for (const bad of ["", "0", "0.00", "-1", "1.001", "1e3", "$5", "1,000.00", "abc"]) {
      expect(() => toCents(bad), bad).toThrow(/amount/);
    }
    expect(() => toCents(0.1 + 0.2)).toThrow(/cents/);
    expect(() => toCents(Number.NaN)).toThrow();
  });

  it("converts to and from token base units without floats", () => {
    expect(toBaseUnits("25.00", 6)).toBe(25_000_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(/6 decimals/);
    expect(formatBaseUnits(1_534_246n, 6)).toBe("1.534246");
    expect(formatBaseUnits(50_000_000n, 6)).toBe("50.00");
    expect(formatBaseUnits(50_100_000n, 6)).toBe("50.10");
  });

  it("formats USD deterministically", () => {
    expect(formatUsd(128_450n)).toBe("$1,284.50");
    expect(formatUsd(5_038n)).toBe("$50.38");
    // The quote's own figures, zero included: a four-minute plan's interest rounds to "0.00".
    expect(formatUsdAmount("50.38")).toBe("$50.38");
    expect(formatUsdAmount("0.00")).toBe("$0.00");
    expect(formatUsdAmount("1234.50")).toBe("$1,234.50");
    expect(() => formatUsdAmount("50.3")).toThrow(/two-decimal/);
    expect(formatUsd(-100n)).toBe("−$1.00");
    expect(formatUsd(123_456_789_012n)).toBe("$1,234,567,890.12");
  });
});

/**
 * PolarisLoanEngine, transcribed. `thresholdFor(k)` is the cumulative amount
 * that must be repaid for `k` instalments to count, rounded up; instalment `i`
 * (0-based) is the step between two rungs and falls due at
 * `startedAt + (i + 1) * interval`. Nothing is collected at origination.
 */
function engineThreshold(totalOwed: bigint, k: bigint, count: bigint): bigint {
  if (k === 0n) return 0n;
  if (k >= count) return totalOwed;
  return (totalOwed * k + count - 1n) / count;
}

function engineSchedule(principal: bigint, count: number, interval: number, aprBps: number) {
  const n = BigInt(count);
  const interest = (principal * BigInt(aprBps) * n * BigInt(interval)) / (10_000n * 31_536_000n);
  const totalOwed = principal + interest;
  return Array.from({ length: count }, (_, i) => ({
    amount: engineThreshold(totalOwed, BigInt(i + 1), n) - engineThreshold(totalOwed, BigInt(i), n),
    dueAfterStart: (i + 1) * interval,
  }));
}

describe("Pay in 4 quote", () => {
  it("matches the loan engine: $200 at 10% over four weekly instalments is 4 × $50.38", () => {
    const q = quotePayIn4("200.00");
    expect(q.each).toBe("50.38");
    expect(q.interest).toBe("1.53");
    expect(q.total).toBe("201.53");
    expect(q.aprBps).toBe(PAY_IN_4.aprBps);
    expect(q.intervalSeconds).toBe(7 * 86_400);
    expect(q.interestFree).toBe(false);
  });

  it("collects nothing at checkout: instalment i is due (i + 1) intervals after it, as installmentDueAt says", () => {
    const q = quotePayIn4("200.00");
    expect(q.installments.map((i) => i.dueInSeconds)).toEqual([604_800, 1_209_600, 1_814_400, 2_419_200]);
    expect(q.installments.every((i) => i.dueInSeconds > 0)).toBe(true);

    const fast = quotePayIn4("200.00", { intervalSeconds: 60 });
    expect(fast.installments.map((i) => i.dueInSeconds)).toEqual([60, 120, 180, 240]);
  });

  it("splits the total on the engine's rounded-up ladder, not floor plus a remainder", () => {
    // totalOwed = 201_534_246. thresholdFor(k) = ceil(totalOwed * k / 4):
    // 50_383_562, 100_767_123, 151_150_685, 201_534_246.
    const q = quotePayIn4("200.00");
    expect(q.installments.map((i) => i.amountBaseUnits)).toEqual([50_383_562n, 50_383_561n, 50_383_562n, 50_383_561n]);
  });

  it("computes interest in base units exactly as PolarisLoanEngine.createLoan does", () => {
    // interest = principal * 1000 * (4 * 7d) / (10_000 * 365d), floored
    const principal = 200_000_000n;
    const expected = (principal * 1000n * 4n * 604_800n) / (10_000n * 31_536_000n);
    const q = quotePayIn4("200.00");
    const total = q.installments.reduce((sum, i) => sum + i.amountBaseUnits, 0n);
    expect(total).toBe(principal + expected);
  });

  it("agrees with the engine instalment for instalment across amounts, counts, intervals and rates", () => {
    const amounts = ["1.00", "19.99", "200.00", "201.50", "333.33", "999.99", "4999.97"];
    const counts = [1, 2, 3, 4, 6, 7, 12, 24];
    const intervals = [60, 3_600, 86_400, 604_800, 1_209_600];
    const rates = [0, 1_000, 2_999];
    for (const amount of amounts) {
      const principal = toBaseUnits(amount, 6);
      for (const installments of counts) {
        for (const intervalSeconds of intervals) {
          for (const aprBps of rates) {
            const label = `${amount} × ${installments} every ${intervalSeconds}s at ${aprBps}bps`;
            const q = quotePayIn4(amount, { installments, intervalSeconds, aprBps });
            const engine = engineSchedule(principal, installments, intervalSeconds, aprBps);
            expect(q.installments.map((i) => i.amountBaseUnits), label).toEqual(engine.map((e) => e.amount));
            expect(q.installments.map((i) => i.dueInSeconds), label).toEqual(engine.map((e) => e.dueAfterStart));
          }
        }
      }
    }
  });

  it("reads interest-free at 0% APR", () => {
    const q = quotePayIn4("200.00", { aprBps: 0 });
    expect(q.each).toBe("50.00");
    expect(q.interest).toBe("0.00");
    expect(q.interestFree).toBe(true);
  });

  it("rounds half up to the cent for display", () => {
    const q = quotePayIn4("201.50", { aprBps: 0 });
    // 201.50 / 4 = 50.375 → "50.38"
    expect(q.each).toBe("50.38");
  });

  it("shows instalments that add up to the total shown", () => {
    // $189 at 10% is 190.449863 owed: "190.45". Four instalments of about
    // 47.6125 each rounded on their own read 4 × 47.61 = 190.44. The running
    // total rounds to 47.61, 95.22, 142.84 and 190.45.
    const q = quotePayIn4("189.00", { aprBps: 1_000 });
    expect(q.total).toBe("190.45");
    expect(q.installments.map((i) => i.amount)).toEqual(["47.61", "47.61", "47.62", "47.61"]);
    expect(q.each).toBe("47.61");

    // And $200: the running total 50.38, 100.77, 151.15, 201.53.
    expect(quotePayIn4("200.00").installments.map((i) => i.amount)).toEqual(["50.38", "50.39", "50.38", "50.38"]);
  });

  it("keeps every displayed instalment within a cent of what the engine draws, summing to the total", () => {
    const amounts = ["1.00", "1.03", "19.99", "189.00", "200.00", "333.33", "999.99", "4999.97"];
    for (const amount of amounts) {
      for (const installments of [1, 2, 3, 4, 6, 7, 12, 24]) {
        for (const aprBps of [0, 1_000, 2_999]) {
          const label = `${amount} × ${installments} at ${aprBps}bps`;
          const q = quotePayIn4(amount, { installments, aprBps });
          const shown = q.installments.map((i) => BigInt(i.amount.replace(".", "")));
          expect(shown.reduce((a, b) => a + b, 0n), label).toBe(toCents(q.total));
          for (const [i, row] of q.installments.entries()) {
            const drift = shown[i]! * 10_000n - row.amountBaseUnits;
            expect(drift < 10_000n && drift > -10_000n, `${label}, instalment ${row.index}`).toBe(true);
          }
        }
      }
    }
  });

  it("validates its options", () => {
    expect(() => quotePayIn4("10.00", { installments: 0 })).toThrow(/installments/);
    expect(() => quotePayIn4("10.00", { intervalSeconds: 5 })).toThrow(/intervalSeconds/);
    expect(() => quotePayIn4("10.00", { aprBps: -1 })).toThrow(/aprBps/);
  });
});
