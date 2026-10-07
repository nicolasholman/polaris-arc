import { describe, expect, it } from "vitest";

import { centsToUnits, formatCents, formatUnits, installmentAmounts, parseCents, quotePlanLocally, thresholdFor, unitsToCents } from "@/server/chain/money";
import { periodSeconds } from "@/server/sessions/params";

describe("money", () => {
  it("prices $200 in four weekly instalments exactly as the loan engine does", () => {
    const { interest, total } = quotePlanLocally(200_000_000n, 4, 604_800);
    expect(interest).toBe(1_534_246n);
    expect(total).toBe(201_534_246n);
    const amounts = installmentAmounts(total, 4);
    expect(amounts).toEqual([50_383_562n, 50_383_561n, 50_383_562n, 50_383_561n]);
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(total);
    expect(thresholdFor(total, 4, 1)).toBe(50_383_562n);
    expect(thresholdFor(total, 4, 4)).toBe(total);
  });

  it("formats USD the way webhooks carry it", () => {
    expect(formatUnits(25_000_000n)).toBe("25.00");
    expect(formatUnits(201_534_246n)).toBe("201.534246");
    expect(formatUnits(125_000n)).toBe("0.125");
    expect(formatUnits(0n)).toBe("0.00");
    expect(formatCents(20000)).toBe("200.00");
    expect(formatCents(5)).toBe("0.05");
  });

  it("parses prices strictly, with no float maths", () => {
    expect(parseCents("200.00")).toBe(20000);
    expect(parseCents("200")).toBe(20000);
    expect(parseCents("0.5")).toBe(50);
    expect(parseCents(9.99)).toBe(999);
    expect(parseCents("12.345")).toBeNull();
    expect(parseCents("-1")).toBeNull();
    expect(parseCents("1e3")).toBeNull();
    expect(parseCents(null)).toBeNull();
    expect(centsToUnits(2500)).toBe(25_000_000n);
    expect(unitsToCents("25009999")).toBe(2500);
  });

  it("turns subscription terms into seconds", () => {
    expect(periodSeconds({ interval: "month", intervalCount: 1 })).toBe(2_592_000);
    expect(periodSeconds({ interval: "week", intervalCount: 2 })).toBe(1_209_600);
    expect(periodSeconds({ interval: "year", intervalCount: 1 })).toBe(31_536_000);
  });
});
