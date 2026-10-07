"use client";

import { motion } from "motion/react";
import { useId, type SVGAttributes } from "react";

import { cn } from "../lib/cn";
import { useReducedMotionSafe } from "../lib/hooks";
import { linePath, project, smoothPath } from "./geometry";

export type SparklineProps = Omit<SVGAttributes<SVGSVGElement>, "fill"> & {
  data: number[];
  /** Any CSS colour; defaults to the text colour. */
  color?: string;
  /** Pixel height; the width fills the container unless `width` is set. */
  height?: number;
  width?: number;
  strokeWidth?: number;
  /** A soft gradient under the line (ref C's favourites). */
  fill?: boolean;
  /** A dotted guide (ref D's sales card) at the average, the first value, or a number. */
  baseline?: "avg" | "first" | number;
  curve?: "smooth" | "linear";
  /** Reveal left to right on mount. */
  animate?: boolean;
  /** Read out instead of being decorative. */
  label?: string;
};

/**
 * A tiny trend line. Scales to its container; the stroke stays crisp.
 *
 * ```tsx
 * <Sparkline data={[4, 6, 5, 8, 7, 9]} color="var(--ui-up)" height={32} />
 * <Sparkline data={sales} baseline="avg" curve="linear" strokeWidth={2.25} />
 * <Sparkline data={series} fill color="var(--ui-purple-deep)" />
 * ```
 */
export function Sparkline({
  data,
  color = "currentColor",
  height = 36,
  width,
  strokeWidth = 1.75,
  fill = false,
  baseline,
  curve = "smooth",
  animate = true,
  label,
  className,
  style,
  ...props
}: SparklineProps) {
  const id = useId();
  // Hydration-safe: false until mounted, so the draw-in markup matches the server.
  const reduced = useReducedMotionSafe();
  const W = 200;
  const H = 100;
  const pad = 6;
  if (data.length === 0) return null;
  const { points, y } = project(data, { width: W, height: H, top: pad, bottom: pad });
  const d = curve === "smooth" ? smoothPath(points) : linePath(points);
  const area = `${d}L${W} ${H}L0 ${H}Z`;
  const guide =
    baseline === undefined
      ? null
      : y(baseline === "avg" ? data.reduce((a, b) => a + b, 0) / data.length : baseline === "first" ? data[0]! : baseline);
  const reveal = animate && !reduced;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("block overflow-visible", !width && "w-full", className)}
      style={{ height, width, color, ...style }}
      {...props}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <motion.rect
            key={reveal ? "reveal" : "still"}
            x="0"
            y="-20"
            height={H + 40}
            initial={{ width: reveal ? 0 : W + 10 }}
            animate={{ width: W + 10 }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          />
        </clipPath>
      </defs>
      {guide !== null ? (
        <line
          x1="0"
          x2={W}
          y1={guide}
          y2={guide}
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1"
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <g clipPath={`url(#${id}-clip)`}>
        {fill ? <path d={area} fill={`url(#${id}-fill)`} /> : null}
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}
