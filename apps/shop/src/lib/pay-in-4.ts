import { quotePayIn4 } from "polarispay-sdk";

import { decimalToCents } from "@/lib/money";

/**
 * Pay in 4 as the store shows it, from the SDK's quote of PolarisLoanEngine:
 * simple interest at the APR, four weekly instalments, the first one
 * interval after checkout (nothing is paid at checkout), and rows that add
 * up to the total. Every surface (the home band, product pages, the bag,
 * checkout, the receipt) quotes from here, so they can't disagree.
 */
export type PayIn4View = {
  /** Cents: the headline "4 × $87.92". */
  each: number;
  interest: number;
  total: number;
  aprBps: number;
  intervalSeconds: number;
  installments: { index: number; amount: number; dueInSeconds: number }[];
};

export function payIn4(totalCents: number, aprBps: number): PayIn4View | null {
  if (!Number.isInteger(totalCents) || totalCents <= 0) return null;
  const quote = quotePayIn4((totalCents / 100).toFixed(2), { aprBps });
  const cents = (value: string) => decimalToCents(value) ?? 0;
  return {
    each: cents(quote.each),
    interest: cents(quote.interest),
    total: cents(quote.total),
    aprBps: quote.aprBps,
    intervalSeconds: quote.intervalSeconds,
    installments: quote.installments.map((inst) => ({ index: inst.index, amount: cents(inst.amount), dueInSeconds: inst.dueInSeconds })),
  };
}

/** "10% APR", "12.5% APR". */
export function aprLabel(aprBps: number): string {
  return `${aprBps / 100}% APR`;
}

const WEEK = 7 * 86_400;

/** "Week 1" … "Week 4" for weekly plans; otherwise a date. */
export function weekLabel(dueInSeconds: number): string | null {
  return dueInSeconds % WEEK === 0 ? `Week ${dueInSeconds / WEEK}` : null;
}
