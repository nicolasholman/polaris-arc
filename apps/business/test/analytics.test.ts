import { describe, expect, it } from "vitest";

import { periodSummary, salesByMode, salesSeries, salesSummary, type SeriesFrame } from "@/lib/data/analytics";
import type { Payment } from "@/lib/data/types";

import { testPayments } from "./helpers/payments";

/**
 * The Overview's line (ref E): a smoothed running total over the chart's own
 * window, so it starts at zero, never dips, and ends at the headline figure.
 */

const NOW = Date.UTC(2026, 8, 27, 15, 7);

describe("salesSeries", () => {
  const payments = testPayments(NOW);

  it.each<SeriesFrame>(["1h", "24h", "1w", "1m"])("is a running total at %s: 0 at the left edge, monotone, ending at the gross", (frame) => {
    const s = salesSeries(payments, frame, { now: NOW });
    const values = s.points.map((p) => p.value);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(s.grossCents / 100);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
  });

  it("has sales in the last day, so the 24h line rises from 0 to the headline", () => {
    const s = salesSeries(payments, "24h", { now: NOW });
    expect(s.grossCents).toBeGreaterThan(0);
    expect(s.points.at(-1)!.value).toBe(s.grossCents / 100);
    expect(s.candles.length).toBeGreaterThan(0);
  });

  it("ends at the gross for one sale placed in the window", () => {
    const sale = { ...payments.find((p) => p.status === "succeeded")!, id: "x", amountCents: 12_34, createdAt: new Date(NOW - 3 * 3_600_000).toISOString() };
    const s = salesSeries([sale], "24h", { now: NOW });
    expect(s.grossCents).toBe(12_34);
    expect(s.points[0]!.value).toBe(0);
    expect(s.points.at(-1)!.value).toBe(12.34);
  });
});

/**
 * R1 B5: the Payments tiles read $0.00 while the list showed a paid $2.00
 * payment, because the summary dropped rows newer than the moment the page
 * opened (and the fork's block time ran ~110 s ahead of the wall clock). A
 * row newer than the caller's clock happened: it counts as now.
 */
describe("trailing windows never drop a row newer than now", () => {
  const sale = (createdAt: number, cents = 2_00): Payment => {
    const base: Payment = { ...testPayments(NOW).find((p) => p.status === "succeeded")! };
    delete base.netUnits;
    return { ...base, id: `pay_${createdAt}`, mode: "now", amountCents: cents, feeCents: 1, netCents: cents - 1, createdAt: new Date(createdAt).toISOString() };
  };

  it("periodSummary counts a payment dated after `now` (chain clock ahead, or the page's clock older than the data)", () => {
    const ahead = sale(NOW + 110_000);
    const s = periodSummary([ahead], { days: 30, now: NOW });
    expect(s).toMatchObject({ gross: 2_00, fees: 1, net: 1_99, count: 1, failed: 0 });
  });

  it("periodSummary still leaves out what is older than the window", () => {
    const old = sale(NOW - 40 * 86_400_000);
    expect(periodSummary([old], { days: 30, now: NOW }).count).toBe(0);
  });

  it("salesByMode, salesSummary and salesSeries count it too", () => {
    const ahead = sale(NOW + 110_000);
    expect(salesByMode([ahead], { days: 30, now: NOW }).find((m) => m.mode === "now")!.cents).toBe(2_00);
    expect(salesSummary([ahead], { days: 30, now: NOW })).toMatchObject({ grossCents: 2_00, count: 1 });
    for (const frame of ["1h", "24h", "1w", "1m"] as const) {
      const s = salesSeries([ahead], frame, { now: NOW });
      expect(s.grossCents, frame).toBe(2_00);
      expect(s.points.at(-1)!.value, frame).toBe(2);
    }
  });
});
