import { Money } from "@polaris/ui";
import type { ReactNode } from "react";
import type { ActivityItem } from "@/lib/data";
import { movesBalance, n, signed } from "@/lib/view";

/**
 * A row's amount for `TxRow`: signed when it moved the dollar account, and
 * plain when it didn't (opening a Pay in 4 plan pays the merchant from the
 * credit pool, so it shows what was bought, not money out).
 */
export function rowAmount(item: ActivityItem): { amount?: number; value?: ReactNode } {
  return movesBalance(item) ? { amount: signed(item) } : { value: <Money value={n(item.amount)} dim="none" /> };
}
