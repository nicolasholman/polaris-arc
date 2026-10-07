"use client";

import { motion } from "motion/react";
import { useState, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { useReducedMotionSafe } from "../lib/hooks";
import { arcPath, polar } from "./geometry";

export type DonutSegment = { label: string; value: number; color: string };

export type DonutChartProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  data: DonutSegment[];
  /** Diameter in px. */
  size?: number;
  /** Ring thickness as a share of the radius (ref D is about 0.34). */
  thickness?: number;
  /**
   * 0 (ref D): each segment's round end sits over its neighbour. Above 0,
   * a gap of that many px opens between the rounded ends.
   */
  gap?: number;
  /** Where the first segment starts, in degrees clockwise from 12 o'clock. */
  startAngle?: number;
  /** The floating value tags on each segment. */
  showTags?: boolean;
  formatValue?: (v: number) => string;
  /** The centre: a small label over a big value. Defaults to "Total" and the sum. */
  centerLabel?: ReactNode;
  centerValue?: ReactNode;
  animate?: boolean;
  /** What the chart shows, for screen readers. */
  label: string;
};

/**
 * Ref D's donut: thick rounded segments with gaps, glass value tags that
 * float on the ring, and a centre label. Hover or focus a segment to read
 * it in the centre.
 *
 * ```tsx
 * <DonutChart
 *   label="Sales by mode"
 *   data={[
 *     { label: "Pay now", value: 56685, color: "var(--ui-teal)" },
 *     { label: "Pay in 4", value: 19839, color: "var(--ui-pink)" },
 *     { label: "Subscriptions", value: 17950, color: "var(--ui-honey)" },
 *   ]}
 * />
 * ```
 */
export function DonutChart({
  data,
  size = 300,
  thickness = 0.35,
  gap = 0,
  startAngle = 150,
  showTags = true,
  formatValue = (v) => `$${Math.round(v).toLocaleString("en-US")}`,
  centerLabel,
  centerValue,
  animate = true,
  label,
  className,
  style,
  ...props
}: DonutChartProps) {
  // Hydration-safe: false until mounted, so the draw-in markup matches the server.
  const reduced = useReducedMotionSafe();
  const [focus, setFocus] = useState<number | null>(null);
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const R = size / 2;
  const stroke = R * thickness;
  const r = R - stroke / 2;
  const cx = R;
  const cy = R;
  // Round caps reach half the stroke past each end; leave that plus the gap.
  const capAngle = stroke / 2 / r;
  const gapAngle = gap / r;

  const start = (startAngle * Math.PI) / 180;
  let acc = 0;
  const segs = data.map((d, i) => {
    const share = d.value / total;
    const a0 = start + acc * Math.PI * 2;
    acc += share;
    const a1 = start + acc * Math.PI * 2;
    const span = a1 - a0;
    const trim = gap > 0 ? Math.min(capAngle + gapAngle / 2, span / 2 - 0.001) : 0;
    const s0 = a0 + trim;
    const s1 = Math.max(s0 + 0.0005, a1 - trim);
    const mid = (a0 + a1) / 2;
    return { d, i, share, s0, s1, mid };
  })
    // A segment worth nothing takes no room: no dot, no gap, no tag where two others meet.
    .filter((seg) => seg.d.value > 0);

  const reveal = animate && !reduced;
  const shown = focus !== null ? data[focus] : null;

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("relative shrink-0 font-satoshi", className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
        {segs.map(({ d, i, s0, s1, share }) => (
          <motion.path
            key={`${d.label}-${reveal ? "reveal" : "still"}`}
            d={arcPath(cx, cy, r, s0, s1)}
            fill="none"
            stroke={d.color}
            strokeWidth={stroke}
            strokeLinecap="round"
            tabIndex={0}
            role="img"
            aria-label={`${d.label}: ${formatValue(d.value)}, ${Math.round(share * 100)}%`}
            onPointerEnter={() => setFocus(i)}
            onPointerLeave={() => setFocus(null)}
            onFocus={() => setFocus(i)}
            onBlur={() => setFocus(null)}
            initial={reveal ? { pathLength: 0, opacity: 0 } : false}
            animate={{ pathLength: 1, opacity: focus === null || focus === i ? 1 : 0.35 }}
            transition={{
              pathLength: { delay: reveal ? i * 0.18 : 0, duration: 0.7, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: reveal && focus === null ? 0.2 : 0.2, delay: reveal && focus === null ? i * 0.18 : 0 },
            }}
            className="cursor-pointer outline-none"
          />
        ))}
      </svg>

      {/* centre */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-[15px] text-ui-muted">{shown ? shown.label : (centerLabel ?? "Total")}</div>
          <div
            className="ui-figure mt-1 leading-none font-bold tracking-[-0.03em] text-ui-text"
            style={{ fontSize: Math.round(size * 0.14) }}
          >
            {shown ? formatValue(shown.value) : (centerValue ?? formatValue(total))}
          </div>
        </div>
      </div>

      {/* tags */}
      {showTags
        ? segs.map(({ d, i, mid, share }) => {
            if (share < 0.04) return null;
            // Rounded so the server and the browser print the same numbers.
            const [tx, ty] = polar(cx, cy, R - stroke * 0.18, mid).map((v) => Math.round(v * 100) / 100) as [number, number];
            return (
              <motion.span
                key={`tag-${d.label}-${reveal ? "reveal" : "still"}`}
                aria-hidden
                initial={reveal ? { opacity: 0, y: 6 } : false}
                animate={{ opacity: focus === null || focus === i ? 1 : 0.4, y: 0 }}
                transition={{ delay: reveal && focus === null ? 0.5 + i * 0.18 : 0, duration: 0.35 }}
                className="ui-figure pointer-events-none absolute z-[1] -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-[10px] px-2.5 py-1.5 text-[13px] leading-none font-medium whitespace-nowrap text-white shadow-[0_6px_18px_rgb(0_0_0/0.35)] backdrop-blur-md"
                style={{
                  left: tx,
                  top: ty,
                  background: `color-mix(in oklab, ${d.color} 32%, rgb(24 24 24 / 0.72))`,
                }}
              >
                {formatValue(d.value)}
                <span
                  className="absolute top-full left-1/2 -translate-x-1/2 border-x-[5px] border-t-[5px] border-x-transparent"
                  style={{ borderTopColor: `color-mix(in oklab, ${d.color} 32%, rgb(24 24 24 / 0.72))` }}
                />
              </motion.span>
            );
          })
        : null}
    </div>
  );
}
