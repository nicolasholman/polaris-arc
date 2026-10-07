"use client";

import { motion } from "motion/react";
import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";
import { useReducedMotionSafe } from "../lib/hooks";

export type LegendItem = { label: string; /** Percent, 0 to 100. */ value: number; color: string };

export type ProgressLegendProps = Omit<HTMLAttributes<HTMLUListElement>, "children"> & {
  items: LegendItem[];
  formatValue?: (v: number) => string;
  /** `row`: side by side (ref D); `column`: stacked beside a chart. */
  direction?: "row" | "column";
  animate?: boolean;
};

/**
 * Ref D's legend under the donut: a muted label, a big percentage, and a
 * thin progress bar in the segment's colour.
 *
 * ```tsx
 * <ProgressLegend items={[{ label: "Pay now", value: 60, color: "var(--ui-teal)" }]} />
 * ```
 */
export function ProgressLegend({
  items,
  formatValue = (v) => `${Math.round(v)}%`,
  direction = "row",
  animate = true,
  className,
  ...props
}: ProgressLegendProps) {
  // Hydration-safe: false until mounted, so the draw-in markup matches the server.
  const reduced = useReducedMotionSafe();
  const reveal = animate && !reduced;
  return (
    <ul
      className={cn("grid font-satoshi", direction === "row" ? "gap-6" : "gap-5", className)}
      style={{ gridTemplateColumns: direction === "row" ? `repeat(${items.length}, minmax(0, 1fr))` : "minmax(0, 1fr)" }}
      {...props}
    >
      {items.map((it, i) => (
        <li key={it.label} className="min-w-0">
          <div className="truncate text-[14px] text-ui-muted">{it.label}</div>
          <div className="ui-figure mt-1 text-[22px] leading-tight font-medium tracking-[-0.02em] text-ui-text">
            {formatValue(it.value)}
          </div>
          <div
            role="progressbar"
            aria-label={it.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(it.value)}
            className="mt-2.5 h-[5px] overflow-hidden rounded-full bg-ui-track"
          >
            <motion.div
              key={reveal ? "reveal" : "still"}
              className="h-full rounded-full"
              style={{ background: it.color }}
              initial={reveal ? { width: 0 } : false}
              animate={{ width: `${Math.max(0, Math.min(100, it.value))}%` }}
              transition={{ delay: reveal ? 0.3 + i * 0.08 : 0, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
