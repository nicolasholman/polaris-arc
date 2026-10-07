"use client";

import { formatLocalAmount, rateAgeText } from "@polaris/fx/display";
import { cn } from "@polaris/ui";
import { useFxRate, useTicker } from "@/lib/fx";
import type { Micros } from "@/lib/money";
import { useLocalCurrency } from "@/lib/prefs";

/**
 * The amount in the viewer's currency at the Chainlink rate, and how old that
 * rate is: `{ text: "ARS 161.241", age: "3 min ago" }`. Null for dollar
 * locales, currencies Chainlink has no feed for, and rates older than 26 h.
 */
export function useLocalAmount(amount: Micros): { text: string; age: string } | null {
  const local = useLocalCurrency();
  const rate = useFxRate(local?.currency ?? null);
  const now = useTicker();
  if (!local || !rate || now === null || amount <= 0n) return null;
  const text = formatLocalAmount(amount, local.currency, rate.perUsd, local.locale);
  return text ? { text, age: rateAgeText(rate.updatedAt, now) } : null;
}

/**
 * "≈ ARS 161.241 · Chainlink rate, 3 min ago · indicative": the local-currency
 * line under a dollar figure, for reading only. Nothing at all when there is
 * no fresh rate; never a made-up number.
 */
export function LocalEquivalent({ amount, className }: { amount: Micros; className?: string }) {
  const local = useLocalAmount(amount);
  if (!local) return null;
  return (
    <span
      className={cn("ui-figure text-ui-muted", className)}
      title={`Indicative only, at the Chainlink exchange rate updated ${local.age}. You always pay and get paid in dollars.`}
    >
      {/* Three pieces that each stay whole, so a narrow column wraps between them, never inside. */}
      <span className="whitespace-nowrap">
        <span className="sr-only">About </span>
        <span aria-hidden>≈{"\u00a0"}</span>
        {local.text}
      </span>
      <span className="text-[0.85em]">
        {" "}
        <span className="whitespace-nowrap">· Chainlink rate, {local.age}</span> <span className="whitespace-nowrap">· indicative</span>
      </span>
    </span>
  );
}
