import type { PayMode, Payment } from "@/lib/data/types";

/**
 * A test double: a month of payments ending at `now`, for the chart maths.
 * Deterministic (no randomness), with sales in the last hour, the last day
 * and the weeks before, a mix of modes, and a few failures. Tests only; the
 * product never shows invented payments.
 */
export function testPayments(now: number): Payment[] {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const modes: PayMode[] = ["now", "later", "subscribe"];
  // Minutes before `now`: two in the last hour, a handful today, then roughly two a day for a month.
  const ago = [12 * MINUTE, 47 * MINUTE, 3 * HOUR, 7 * HOUR, 11 * HOUR, 19 * HOUR, 23 * HOUR];
  for (let d = 1; d < 30; d++) ago.push(d * DAY + (d % 5) * HOUR, d * DAY + 13 * HOUR + (d % 7) * 10 * MINUTE);

  return ago.map((before, i) => {
    const mode = modes[i % modes.length]!;
    const amountCents = 25_00 + ((i * 3_717) % 400_00);
    const feeCents = mode === "later" ? 0 : Math.round(amountCents * 0.005);
    const failed = i % 11 === 10;
    return {
      id: `pay_test_${i}`,
      orderId: `order_${i}`,
      description: `Test order ${i}`,
      buyer: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      mode,
      status: failed ? "failed" : "succeeded",
      amountCents,
      feeCents,
      netCents: amountCents - feeCents,
      linkId: null,
      txHash: failed ? null : `0x${(i + 1).toString(16).padStart(64, "0")}`,
      createdAt: new Date(now - before).toISOString(),
    };
  });
}
