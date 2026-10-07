import { Money } from "@polaris/ui";
import type { ReactNode } from "react";
import type { ActivityItem } from "@/lib/data";
import { inEuros, movesBalance, n, signed } from "@/lib/view";

/**
 * A row's amount for `TxRow`: signed when it moved the dollar account, and
 * plain when it didn't (opening a Pay in 4 plan pays the merchant from the
 * credit pool, so it shows what was bought, not money out).
 */
export function rowAmount(item: ActivityItem): { amount?: number; value?: ReactNode } {
  if (inEuros(item)) return { value: <Money value={signed(item)} currency="EUR" signed dim="none" className={item.direction === "in" ? "text-ui-up" : undefined} /> };
  return movesBalance(item) ? { amount: signed(item) } : { value: <Money value={n(item.amount)} dim="none" /> };
}
