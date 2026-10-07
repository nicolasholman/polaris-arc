import type { Instalment, Plan } from "./data/types";

/**
 * A plan's collections after a lost approval, in the states the screens
 * show: "Sign again to pay your instalment", "Collecting…", "Collected".
 * Pure: the data comes from Polaris for Business's buyer book (the chain
 * sync's records of TaskSkipped, Reauthorized and InstallmentPaid).
 */

export type SignAgainState = "needed" | "collecting" | "collected";

/** How long "Collected" stays on the plan after the retry landed. */
export const COLLECTED_SHOWN_MS = 86_400_000;

/** How the plan's collection stands after a lost approval, or null when there is nothing to show. */
export function signAgainState(plan: Plan, now = Date.now()): SignAgainState | null {
  const c = plan.collection;
  if (!c || (plan.status !== "active" && !c.reauthorized?.collected)) return null;
  if (c.needsSignature) return "needed";
  if (c.reauthorized && !c.reauthorized.collected) return "collecting";
  if (c.reauthorized?.collected && now - c.reauthorized.collected.at < COLLECTED_SHOWN_MS) return "collected";
  return null;
}

/** Plans whose payments need the buyer to sign again. */
export function plansNeedingSignature(plans: Plan[] | undefined): Plan[] {
  return (plans ?? []).filter((p) => p.status === "active" && p.collection?.needsSignature === true);
}

/** The payment a failed collection was for: the first unpaid one. */
export function duePayment(plan: Plan): Instalment | null {
  return plan.instalments.find((i) => i.paidAt === null) ?? null;
}

/**
 * What a permit to the loan engine must cover: everything still owed on
 * every open plan (a permit replaces the approval, and
 * PolarisCheckout.reauthorize refuses less than `activeDebtOf`). The chain's
 * own figure is used when it can be read; this is the fallback.
 */
export function owedOnOpenPlans(plans: Plan[]): bigint {
  return plans
    .filter((p) => p.status === "active")
    .reduce((sum, p) => sum + p.instalments.filter((i) => i.paidAt === null).reduce((s, i) => s + i.amount, 0n), 0n);
}
