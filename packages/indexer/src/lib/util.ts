/** Small pure helpers shared by the handlers. No I/O, no Envio imports. */

export const PROTOCOL_ID = "polaris";
export const SECONDS_PER_DAY = 86_400;

/** How a merchant was paid. */
export type PaymentMode = "PAY_NOW" | "PAY_IN_4" | "SUBSCRIPTION";

/** The merchant-facing events the webhook dispatcher sends (plan 5.8). */
export const WEBHOOK_KINDS = [
  "payment.succeeded",
  "plan.opened",
  "installment.collected",
  "installment.failed",
  "plan.completed",
  "plan.liquidated",
  "subscription.charged",
  "subscription.canceled",
  "payout.paid",
] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

/** CollectionsReceiver task actions (plan 3.3). */
export const COLLECTION_ACTION = { COLLECT_INSTALLMENT: 1, CHARGE_SUBSCRIPTION: 2, LIQUIDATE: 3 } as const;

/** Days since the epoch, UTC. */
export function dayOf(timestamp: number): number {
  return Math.floor(timestamp / SECONDS_PER_DAY);
}

/** YYYY-MM-DD for a day index. */
export function dateOf(day: number): string {
  return new Date(day * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
}

/**
 * The Activity cursor: blockNumber * 10^8 + logIndex * 100 + slot. Unique per
 * activity (one log yields at most 100; a repayment that completes all 24
 * instalments of the longest plan yields 24), and increasing in chain order,
 * so the webhook dispatcher can page with `cursor > last`.
 */
export const MAX_ACTIVITY_SLOT = 99;
export function cursorOf(blockNumber: number, logIndex: number, slot = 0): bigint {
  if (slot < 0 || slot > MAX_ACTIVITY_SLOT) throw new Error(`activity slot ${slot} out of range`);
  if (logIndex < 0 || logIndex >= 1_000_000) throw new Error(`log index ${logIndex} out of range`);
  return BigInt(blockNumber) * 100_000_000n + BigInt(logIndex) * 100n + BigInt(slot);
}

/**
 * polarispay-sdk's InstallmentFailureReason, from what a skipped collection
 * asks of the buyer: top up (insufficient_funds) or sign again
 * (allowance_lost). The API, the SDK, the webhooks and the CRE workflow use
 * this vocabulary; a skip's `reasonAction` is already in it, or `stale`.
 */
export type FailureReason = "insufficient_funds" | "allowance_lost" | "other";
export function failureReasonOf(action: string | undefined): FailureReason {
  if (action === "insufficient_funds" || action === "allowance_lost") return action;
  return "other";
}

/** `<txHash>-<logIndex>`: the id of a row that one log creates. */
export function logId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** A uint that fits an Int column (timestamps, counts, small enums). */
export function toInt(value: bigint | number): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n > 2_147_483_647 || n < -2_147_483_648) {
    throw new Error(`${value} does not fit a 32-bit Int`);
  }
  return n;
}

export function lower(address: string): string {
  return address.toLowerCase();
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Monthly recurring revenue of one subscription: its price per 30 days. */
export function monthlyValue(pricePerPeriod: bigint, periodSeconds: number): bigint {
  if (periodSeconds <= 0) return 0n;
  return (pricePerPeriod * BigInt(30 * SECONDS_PER_DAY)) / BigInt(periodSeconds);
}
