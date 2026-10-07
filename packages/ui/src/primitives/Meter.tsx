import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export type MeterTone = "lime" | "amber" | "red" | "neutral";

export type MeterProps = Omit<HTMLAttributes<HTMLDivElement>, "role"> & {
  /** 0 to 1; clamped. */
  value: number;
  /** What it measures, read out: "Time since the last check, of the hour allowed". */
  label: string;
  /** The value in words for assistive tech: "12 minutes of 60". */
  valueText?: string;
  tone?: MeterTone;
  size?: "sm" | "md";
};

const FILL: Record<MeterTone, string> = {
  lime: "bg-ui-lime",
  amber: "bg-ui-warn",
  red: "bg-ui-down",
  neutral: "bg-ui-muted",
};

/**
 * A thin gauge: how much of an allowance is used (the guard's check age
 * against its maximum, a price against its floor). Not a progress bar for
 * work in flight.
 *
 * ```tsx
 * <Meter value={12 / 60} label="Time since the last check" valueText="12 min of 60" tone="lime" />
 * ```
 */
export function Meter({ value, label, valueText, tone = "lime", size = "md", className, ...props }: MeterProps) {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-valuetext={valueText}
      className={cn("w-full overflow-hidden rounded-full bg-ui-surface-2", size === "sm" ? "h-1.5" : "h-2", className)}
      {...props}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", FILL[tone])} style={{ width: `${v * 100}%` }} />
    </div>
  );
}
