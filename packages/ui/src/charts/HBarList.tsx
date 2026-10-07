"use client";

import { motion } from "motion/react";
import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";
import { useReducedMotionSafe } from "../lib/hooks";

export type HBar = { label: string; /** Share in percent. */ value: number; color?: string };

/** Ref A's order: blue, yellow, lilac, salmon, cyan, mint. */
export const HBAR_COLORS = [
  "var(--ui-blue)",
  "var(--ui-yellow)",
  "var(--ui-lilac)",
  "var(--ui-salmon)",
  "var(--ui-cyan)",
  "var(--ui-mint)",
  "var(--ui-pink)",
  "var(--ui-sky)",
];

export type HBarListProps = Omit<HTMLAttributes<HTMLUListElement>, "children"> & {
  data: HBar[];
  /** The narrowest bar, in percent of the row, so the label always fits. */
  minWidth?: number;
  barHeight?: number;
  formatValue?: (v: number) => string;
  animate?: boolean;
  /** What the list shows, for screen readers. */
  label: string;
};

/**
 * Ref A's category bars: pastel bars stacked tight, each as wide as its
 * share (the largest fills the row), the label inside at the start and the
 * percentage at the end.
 *
 * ```tsx
 * <HBarList label="Spending by category" data={[{ label: "Food", value: 25 }, { label: "Travel", value: 20 }]} />
 * ```
 */
export function HBarList({
  data,
  minWidth = 28,
  barHeight = 52,
  formatValue = (v) => `${Math.round(v)}%`,
  animate = true,
  label,
  className,
  ...props
}: HBarListProps) {
  // Hydration-safe: false until mounted, so the draw-in markup matches the server.
  const reduced = useReducedMotionSafe();
  const max = Math.max(1, ...data.map((d) => d.value));
  const reveal = animate && !reduced;
  return (
    <ul aria-label={label} className={cn("flex flex-col gap-2 font-satoshi", className)} {...props}>
      {data.map((d, i) => {
        const width = minWidth + (100 - minWidth) * (d.value / max);
        return (
          <li key={d.label} className="flex">
            <motion.div
              key={reveal ? "reveal" : "still"}
              initial={reveal ? { width: `${minWidth * 0.6}%`, opacity: 0 } : false}
              animate={{ width: `${width}%`, opacity: 1 }}
              transition={{ delay: reveal ? i * 0.06 : 0, type: "spring", stiffness: 160, damping: 22 }}
              className="flex min-w-fit items-center justify-between gap-4 rounded-[16px] px-5 text-[#13141f]"
              style={{ height: barHeight, background: d.color ?? HBAR_COLORS[i % HBAR_COLORS.length] }}
            >
              <span className="truncate text-[16px] font-medium tracking-[-0.01em]">{d.label}</span>
              <span className="ui-figure shrink-0 text-[13px] font-semibold">{formatValue(d.value)}</span>
            </motion.div>
          </li>
        );
      })}
    </ul>
  );
}
