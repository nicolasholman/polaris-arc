"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "../lib/cn";
import { linePath, project, smoothPath, useSize } from "./geometry";

export type LinePoint = { value: number; label?: string };

export type LineAreaProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  data: number[] | LinePoint[];
  height?: number;
  /** The line colour (white on the purple cards). */
  color?: string;
  /** Gradient fill under the line. */
  fill?: boolean;
  /** A soft blurred copy under the line (ref B's glow). */
  glow?: boolean;
  strokeWidth?: number;
  curve?: "smooth" | "linear";
  /** A dashed horizontal guide at the average or a value (ref B). */
  reference?: "avg" | number;
  /** Crosshair and a value readout on hover, drag and arrow keys. */
  interactive?: boolean;
  formatValue?: (v: number) => string;
  /** Room above and below the line, in px. */
  inset?: { top?: number; bottom?: number };
  animate?: boolean;
  /** What the chart shows, for screen readers. */
  label: string;
};

/**
 * The price and spending line: a glowing stroke over a gradient that fades
 * to nothing, with an optional dashed reference and a hover readout.
 *
 * ```tsx
 * <LineArea label="Credit score, 6 months" data={scores} height={220} glow reference="avg" interactive />
 * <LineArea label="Spending this week" data={week} height={72} curve="linear" />
 * ```
 */
export function LineArea({
  data,
  height = 200,
  color = "#ffffff",
  fill = true,
  glow = true,
  strokeWidth = 2.5,
  curve = "smooth",
  reference,
  interactive = false,
  formatValue = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 2 }),
  inset,
  animate = true,
  label,
  className,
  style,
  ...props
}: LineAreaProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const points = data.map((d) => (typeof d === "number" ? { value: d } : d));
  const values = points.map((p) => p.value);
  const W = Math.max(1, size.width);
  const H = height;
  const top = inset?.top ?? 12;
  const bottom = inset?.bottom ?? 4;
  const proj = values.length ? project(values, { width: W, height: H, top, bottom, left: strokeWidth, right: strokeWidth }) : null;
  const d = proj ? (curve === "smooth" ? smoothPath(proj.points) : linePath(proj.points)) : "";
  const area = proj ? `${d}L${W - strokeWidth} ${H}L${strokeWidth} ${H}Z` : "";
  const refY =
    proj && reference !== undefined
      ? proj.y(reference === "avg" ? values.reduce((a, b) => a + b, 0) / values.length : reference)
      : null;

  const indexAt = (clientX: number) => {
    const el = ref.current;
    if (!el || values.length === 0) return null;
    const r = el.getBoundingClientRect();
    const t = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(values.length - 1, Math.round(t * (values.length - 1))));
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    setHover(indexAt(e.clientX));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setHover((h) => Math.max(0, Math.min(values.length - 1, (h ?? (step > 0 ? -1 : values.length)) + step)));
    } else if (e.key === "Escape") setHover(null);
  };

  const hp = hover !== null && proj ? proj.points[hover] : null;
  // Draw in once: a later remount (a resize that re-measures) shows the line at rest.
  const drawn = useRef(false);
  const measured = size.width > 0 && values.length > 0;
  useEffect(() => {
    if (measured) drawn.current = true;
  }, [measured]);
  const reveal = animate && !reduced && !drawn.current;
  const last = values[values.length - 1];

  return (
    <div
      ref={ref}
      role="img"
      aria-label={`${label}${last !== undefined ? `, latest ${formatValue(last)}` : ""}`}
      tabIndex={interactive ? 0 : undefined}
      onPointerMove={onMove}
      onPointerDown={onMove}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
      className={cn(
        "relative w-full select-none",
        interactive && "cursor-crosshair touch-pan-y focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus rounded-[12px]",
        className,
      )}
      style={{ height, color, ...style }}
      {...props}
    >
      {size.width > 0 && proj ? (
        <svg width={W} height={H} className="absolute inset-0 overflow-visible" aria-hidden>
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.34" />
              <stop offset="0.7" stopColor="currentColor" stopOpacity="0.06" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
            <filter id={`${id}-glow`} x="-10%" y="-30%" width="120%" height="160%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
            <clipPath id={`${id}-clip`}>
              <motion.rect
                x="-4"
                y="-40"
                height={H + 80}
                initial={{ width: reveal ? 0 : W + 8 }}
                animate={{ width: W + 8 }}
                transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
              />
            </clipPath>
          </defs>
          {refY !== null ? (
            <line
              x1="0"
              x2={W}
              y1={refY}
              y2={refY}
              stroke="currentColor"
              strokeOpacity="0.4"
              strokeWidth="1"
              strokeDasharray="5 5"
            />
          ) : null}
          <g clipPath={`url(#${id}-clip)`}>
            {fill ? <path d={area} fill={`url(#${id}-fill)`} /> : null}
            {glow ? (
              <path
                d={d}
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.55"
                strokeWidth={strokeWidth * 2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                filter={`url(#${id}-glow)`}
              />
            ) : null}
            <path d={d} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
          </g>
          {hp ? (
            <g>
              <line x1={hp[0]} x2={hp[0]} y1={0} y2={H} stroke="currentColor" strokeOpacity="0.45" strokeDasharray="3 4" />
              <circle cx={hp[0]} cy={hp[1]} r="7" fill="currentColor" fillOpacity="0.25" />
              <circle cx={hp[0]} cy={hp[1]} r="4" fill="currentColor" />
            </g>
          ) : null}
        </svg>
      ) : null}
      {hp && hover !== null ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute z-[1] -translate-x-1/2 -translate-y-full rounded-[10px] bg-white px-2.5 py-1.5 font-satoshi text-[13px] leading-none font-medium whitespace-nowrap text-[#13141f] shadow-[0_6px_16px_rgb(0_0_0/0.2)]"
          style={{ left: Math.max(40, Math.min(W - 40, hp[0])), top: hp[1] - 12 }}
        >
          <span className="ui-figure">{formatValue(values[hover]!)}</span>
          {points[hover]!.label ? <span className="ml-1.5 text-[#6e7080]">{points[hover]!.label}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
