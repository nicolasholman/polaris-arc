import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";
import { DeltaChip } from "./Chips";

export type BalanceStat = { label: ReactNode; value: ReactNode };

export type BalanceSummaryCardProps = HTMLAttributes<HTMLDivElement> & {
  /** "Available Balance". */
  label: ReactNode;
  /** "293.0187 ETH". */
  value: ReactNode;
  /** The chip beside the value, in percent; omit for none. */
  delta?: number | null;
  deltaSuffix?: string;
  /** Replaces the chip. */
  badge?: ReactNode;
  /** The row under it: "Estimate fee · You will receive · Spread". */
  stats?: BalanceStat[];
};

/**
 * The widget's outlined summary card: a hairline border on the panel, the
 * available balance with a lime delta chip, and a row of three small stats,
 * the last one flush right.
 *
 * ```tsx
 * <BalanceSummaryCard
 *   label="Available balance"
 *   value="$3,196.97"
 *   delta={7.45}
 *   stats={[{ label: "Network fee", value: "$0.00" }, { label: "You receive", value: "$1,250.00" }, { label: "Settles in", value: "0.8 s" }]}
 * />
 * ```
 */
export function BalanceSummaryCard({ label, value, delta, deltaSuffix, badge, stats, className, ...props }: BalanceSummaryCardProps) {
  return (
    <div className={cn("rounded-ui-panel border border-ui-hairline-strong px-5 pt-4 pb-5 font-satoshi", className)} {...props}>
      <p className="text-[14px] leading-tight text-ui-muted">{label}</p>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="ui-figure min-w-0 truncate text-[28px] leading-none font-medium tracking-[-0.025em] text-ui-text">{value}</span>
        {badge ?? (delta !== undefined ? <DeltaChip value={delta} suffix={deltaSuffix} variant="strong" /> : null)}
      </div>
      {stats?.length ? (
        <dl className="mt-5 flex items-start justify-between gap-4">
          {stats.map((s, i) => (
            <div key={i} className={cn("min-w-0", i === stats.length - 1 && stats.length > 1 && "text-right")}>
              <dt className="truncate text-[14px] leading-tight text-ui-muted">{s.label}</dt>
              <dd className="ui-figure mt-1.5 truncate text-[14px] leading-tight font-semibold text-ui-text">{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
