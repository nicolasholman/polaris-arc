import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export type TicksProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** Paid (or done) so far. */
  done: number;
  total: number;
  /** A tick that is late or retrying, drawn in the warning colour after the done ones. */
  late?: number;
  /** `sm` 4px tall (rows), `md` 6px (ref B's featured tiles). */
  size?: "sm" | "md";
  /** Read out instead of "2 of 4 paid". */
  label?: string;
};

/**
 * Instalment ticks: one rounded bar per instalment, lime when paid (ref B's
 * Active plans). The Pay in 4 ledger's progress column.
 *
 * ```tsx
 * <Ticks done={2} total={4} />
 * <Ticks done={1} late={1} total={4} size="sm" />
 * ```
 */
export function Ticks({ done, total, late = 0, size = "md", label, className, ...props }: TicksProps) {
  return (
    <span
      role="img"
      aria-label={label ?? `${done} of ${total} paid${late ? `, ${late} retrying` : ""}`}
      className={cn("flex gap-1", className)}
      {...props}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "flex-1 rounded-full",
            size === "sm" ? "h-1 min-w-3" : "h-1.5 min-w-4",
            i < done ? "bg-ui-lime" : i < done + late ? "bg-ui-warn" : "bg-ui-surface-3",
          )}
        />
      ))}
    </span>
  );
}
