import { AlertTriangle, Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";

export type CheckItem = {
  key: string;
  /** What is checked: "AUSD/USD", "Free pool cash". */
  label: ReactNode;
  /** The observed figure: "$0.9998". */
  value: ReactNode;
  /** The rule it is held to: "at least $0.995". */
  limit?: ReactNode;
  ok: boolean;
};

export type CheckListProps = {
  items: CheckItem[];
  /** Read before the list: "The guardian's checks". */
  "aria-label"?: string;
  className?: string;
};

/**
 * A set of pass/fail checks, each with the figure observed and the rule it
 * was held to: a lime check or an amber warning in a round well, the label,
 * and on the right the figure over its limit. For the risk guard's four
 * checks, readiness lists and the like.
 *
 * ```tsx
 * <CheckList items={[{ key: "price", label: "AUSD/USD", value: "$0.9998", limit: "at least $0.995", ok: true }]} />
 * ```
 */
export function CheckList({ items, className, ...props }: CheckListProps) {
  return (
    <ul aria-label={props["aria-label"]} className={cn("grid grid-cols-[minmax(0,1fr)] font-satoshi", className)}>
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-3 border-b border-ui-hairline py-3 first:pt-0 last:border-0 last:pb-0">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full",
              item.ok ? "bg-ui-pill-lime text-ui-lime" : "bg-ui-pill-amber text-ui-pill-amber-text",
            )}
          >
            {item.ok ? <Check aria-hidden size={16} strokeWidth={2} /> : <AlertTriangle aria-hidden size={15} strokeWidth={1.75} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] font-medium text-ui-text">{item.label}</span>
            <span className="sr-only">{item.ok ? ", passes" : ", fails"}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className={cn("ui-figure block text-[14.5px] font-medium", item.ok ? "text-ui-text" : "text-ui-pill-amber-text")}>{item.value}</span>
            {item.limit ? <span className="block text-[12px] text-ui-muted">{item.limit}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
