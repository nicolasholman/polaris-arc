/**
 * The dunning ladder, counted from each task's due time, so a buyer who is
 * short is not retried on every run. A task is attempted while `now` is
 * inside a window that opens at its due time and again after each rung of
 * the ladder (6 h, 1 day, 3 days, then weekly by default). A plan past its
 * grace (liquidatable) and a subscription past its charge window are always
 * attempted: the chain decides those.
 */

export const DEFAULT_LADDER_SECONDS = [21_600, 86_400, 259_200, 604_800] as const;

/** PolarisPayments.CHARGE_WINDOW: a renewal missed for longer lapses. */
export const SUBSCRIPTION_CHARGE_WINDOW_SECONDS = 7 * 86_400;

export type Backoff = { ladderSeconds: readonly number[]; windowSeconds: number };

export function onRung(now: number, dueAt: number, b: Backoff): boolean {
  if (now < dueAt) return false;
  let rung = dueAt;
  for (let k = 0; rung <= now; k++) {
    if (now < rung + b.windowSeconds) return true;
    rung += b.ladderSeconds[Math.min(k, b.ladderSeconds.length - 1)]!;
  }
  return false;
}

export function nextRung(now: number, dueAt: number, b: Backoff): number {
  let rung = dueAt;
  for (let k = 0; rung < now; k++) rung += b.ladderSeconds[Math.min(k, b.ladderSeconds.length - 1)]!;
  return rung;
}

export function instalmentDueAt(loan: { startedAt: bigint | number; intervalSeconds: bigint | number; installmentsPaid: number }): number {
  return Number(loan.startedAt) + (loan.installmentsPaid + 1) * Number(loan.intervalSeconds);
}

export type BackoffVerdict =
  | { attempt: true; why: "on-rung" | "past-grace" | "past-charge-window" }
  | { attempt: false; nextAttemptAt: number };

export function loanVerdict(now: number, dueAt: number, liquidatable: boolean, b: Backoff): BackoffVerdict {
  if (liquidatable) return { attempt: true, why: "past-grace" };
  if (onRung(now, dueAt, b)) return { attempt: true, why: "on-rung" };
  return { attempt: false, nextAttemptAt: nextRung(now, dueAt, b) };
}

export function subscriptionVerdict(now: number, nextChargeAt: number, b: Backoff): BackoffVerdict {
  const windowEnd = nextChargeAt + SUBSCRIPTION_CHARGE_WINDOW_SECONDS;
  if (now > windowEnd) return { attempt: true, why: "past-charge-window" };
  if (onRung(now, nextChargeAt, b)) return { attempt: true, why: "on-rung" };
  return { attempt: false, nextAttemptAt: Math.min(nextRung(now, nextChargeAt, b), windowEnd + 1) };
}
