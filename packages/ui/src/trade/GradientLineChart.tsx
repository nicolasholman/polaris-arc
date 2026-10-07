"use client";

import { motion } from "motion/react";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { roundTimes, smoothPath, useSize, type Pt } from "../charts/geometry";
import { compactTickLabels, spanTicks } from "../charts/ticks";
import { cn } from "../lib/cn";
import { useReducedMotionSafe } from "../lib/hooks";

export type GradientPoint = {
  /** When: a timestamp, an ISO date or a label. */
  t: number | string;
  value: number;
};

export type GradientLineChartProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  data: GradientPoint[];
  /** The whole chart's height, x labels included. */
  height?: number;
  /** The point the bubble rests on when nothing is hovered; `null` for none. Defaults to the highest point. */
  defaultIndex?: number | null;
  formatValue?: (v: number) => string;
  /** The y axis labels (defaults to `formatValue`). */
  formatAxis?: (v: number) => string;
  formatTime?: (t: GradientPoint["t"]) => string;
  /** A second, muted line in the bubble (defaults to `formatTime`); `null` hides it. */
  formatBubbleNote?: ((p: GradientPoint) => string) | null;
  /** At most how many x labels (the reference shows six). */
  xTicks?: number;
  /** The y axis gutter, in px. */
  axisWidth?: number;
  /**
   * Below this width (the chart's own, in px) the chart goes compact: a
   * narrower y axis (`compactAxisWidth`) with short labels (`formatAxisCompact`).
   */
  compactBelow?: number;
  compactAxisWidth?: number;
  /**
   * Short y axis labels for the compact chart ("2.5k"). By default the whole
   * axis is labelled together (`compactTickLabels`): one unit, one precision,
   * never two labels the same.
   */
  formatAxisCompact?: (v: number) => string;
  /** A label at the right end, for the latest point ("Now"). */
  lastLabel?: string;
  /** Which clock the round time labels fall on: the viewer's (default) or UTC, to match `formatTime`. */
  tickZone?: "local" | "utc";
  /** Shown over the plot when every value is zero; it can hold buttons. */
  empty?: ReactNode;
  /** What the chart shows, for screen readers. */
  label: string;
  animate?: boolean;
};

const X_AXIS = 36;
const TOP = 44; // room for the bubble over the highest point

/** A timestamp in ms when `t` is a time; null otherwise. */
function timeOf(t: GradientPoint["t"]): number | null {
  const ms = typeof t === "number" ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function defaultTime(t: GradientPoint["t"]): string {
  const d = typeof t === "number" ? new Date(t) : new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Ref E's price line: a smooth line whose colour runs from lime yellow at
 * the top to orange lower down, a warm dark gradient beneath it, the y axis
 * on the left and times along the bottom. Hover, drag or use the arrow keys:
 * a white bubble with the value rides a dashed crosshair over a glowing dot.
 *
 * ```tsx
 * <GradientLineChart label="Sales, last 24 hours" data={points} height={360} formatValue={(v) => `$${v.toFixed(2)}`} />
 * ```
 */
export function GradientLineChart({
  data,
  height = 360,
  defaultIndex,
  formatValue = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  formatAxis,
  formatTime = defaultTime,
  formatBubbleNote,
  xTicks = 6,
  axisWidth: axisWidthWide = 72,
  compactBelow = 480,
  compactAxisWidth = 48,
  formatAxisCompact,
  lastLabel,
  tickZone = "local",
  empty,
  label,
  animate = true,
  className,
  style,
  ...props
}: GradientLineChartProps) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotionSafe();
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);

  const n = data.length;
  const values = data.map((d) => d.value);
  const allZero = values.every((v) => v === 0);
  // Nothing moved: one level line, drawn in the top colour (the gradient
  // would paint it all one mid-plot orange).
  const flat = !allZero && n > 1 && values.every((v) => v === values[0]);
  const W = size.width;
  const compact = W > 0 && W < compactBelow;
  const axisWidth = compact ? compactAxisWidth : axisWidthWide;
  const plotW = Math.max(0, W - axisWidth - 8);
  const plotH = Math.max(0, height - X_AXIS);
  const bottomPad = 10;

  // Four labels, like the reference, from the first round value at or under
  // the lowest point to the first at or over the highest.
  const { lo, hi, ticks } = n ? spanTicks(Math.min(...values), Math.max(...values), 4) : { lo: 0, hi: 1, ticks: [] as number[] };

  const x = (i: number) => axisWidth + 8 + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => TOP + (plotH - TOP - bottomPad) * (1 - (v - lo) / (hi - lo || 1));
  const points: Pt[] = data.map((d, i) => [x(i), y(d.value)]);
  const line = n > 1 ? smoothPath(points) : "";
  const area = n > 1 ? `${line}L${x(n - 1)} ${plotH}L${x(0)} ${plotH}Z` : "";

  const peak = n ? values.indexOf(Math.max(...values)) : -1;
  const rest = defaultIndex === undefined ? (allZero ? null : peak) : defaultIndex;
  const at = hover ?? rest;
  const hp = at !== null && at >= 0 && at < n ? points[at] : null;

  const indexAt = (clientX: number) => {
    const el = ref.current;
    if (!el || n === 0) return null;
    const r = el.getBoundingClientRect();
    const t = (clientX - r.left - axisWidth - 8) / Math.max(1, plotW);
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" || dragging.current) setHover(indexAt(e.clientX));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHover(indexAt(e.clientX));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.pointerType !== "mouse") setHover(null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setHover((h) => Math.max(0, Math.min(n - 1, (h ?? rest ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Escape") setHover(null);
  };

  // Draw in once: a later re-measure shows the line at rest.
  const drawn = useRef(false);
  const measured = W > 0 && n > 1;
  useEffect(() => {
    if (measured) drawn.current = true;
  }, [measured]);
  const reveal = animate && !reduced && !drawn.current;

  // Time labels: as many as fit (about 84px each), up to `xTicks`. When the
  // points are times, the labels sit on round times (2:00 AM, 6:00 AM…, or
  // midnights), placed where that time falls; otherwise on every Nth point.
  const fit = Math.max(2, Math.min(xTicks, Math.floor(plotW / 84) + 1));
  const xLabels: { key: string; px: number; text: string }[] = (() => {
    if (n < 2) return [];
    const endPx = x(n - 1);
    const t0 = timeOf(data[0]!.t);
    const t1 = timeOf(data[n - 1]!.t);
    if (t0 !== null && t1 !== null && t1 > t0) {
      const spanMs = t1 - t0;
      const room = lastLabel ? fit - 1 : fit;
      const out: { key: string; px: number; text: string }[] = [];
      for (const t of roundTimes(t0, t1, room, tickZone)) {
        const px = x(((t - t0) / spanMs) * (n - 1));
        if (lastLabel && endPx - px < 72) continue;
        out.push({ key: String(t), px, text: formatTime(t) });
      }
      if (lastLabel) out.push({ key: "last", px: endPx, text: lastLabel });
      return out;
    }
    const every = Math.max(1, Math.round((n - 1) / Math.max(1, fit - 1)));
    const out = data.map((d, i) => ({ key: String(i), px: x(i), text: formatTime(d.t) })).filter((_, i) => i % every === 0);
    if (lastLabel) {
      while (out.length && endPx - out[out.length - 1]!.px < 72) out.pop();
      out.push({ key: "last", px: endPx, text: lastLabel });
    }
    return out;
  })();
  const axisLabels = compact
    ? formatAxisCompact
      ? ticks.map(formatAxisCompact)
      : compactTickLabels(ticks)
    : ticks.map(formatAxis ?? formatValue);
  const note = formatBubbleNote === null ? null : (formatBubbleNote ?? ((p: GradientPoint) => formatTime(p.t)));
  const last = n ? data[n - 1]! : null;

  return (
    <div
      className={cn("relative w-full font-satoshi select-none", className)}
      style={{ height, ...style }}
      {...props}
    >
      <div
        ref={ref}
        role="img"
        tabIndex={0}
        aria-label={`${label}${last ? `. Latest ${formatValue(last.value)}` : ""}${peak >= 0 && !allZero ? `, highest ${formatValue(values[peak]!)} at ${formatTime(data[peak]!.t)}` : ""}. Use the arrow keys to read each point.`}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse" && !dragging.current) setHover(null);
        }}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="absolute inset-0 cursor-crosshair touch-pan-y rounded-[16px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus"
      >
        {W > 0 && n > 0 ? (
          <svg width={W} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
            <defs>
              {/* The colour follows the value: lime yellow at the top of the plot, orange at the bottom. */}
              <linearGradient id={`${id}-stroke`} gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={plotH - bottomPad}>
                <stop offset="0" stopColor="var(--ui-chart-top)" />
                <stop offset="0.42" stopColor="var(--ui-chart-mid)" />
                <stop offset="0.85" stopColor="var(--ui-chart-bottom)" />
              </linearGradient>
              <linearGradient id={`${id}-fill`} gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={plotH}>
                <stop offset="0" stopColor="var(--ui-chart-top)" stopOpacity="0.07" />
                <stop offset="0.55" stopColor="var(--ui-chart-fill)" stopOpacity="0.06" />
                <stop offset="1" stopColor="var(--ui-chart-fill)" stopOpacity="0" />
              </linearGradient>
              <radialGradient id={`${id}-glow`}>
                <stop offset="0" stopColor="var(--ui-chart-top)" stopOpacity="0.55" />
                <stop offset="1" stopColor="var(--ui-chart-top)" stopOpacity="0" />
              </radialGradient>
              <clipPath id={`${id}-clip`}>
                <motion.rect
                  x={axisWidth}
                  y={-60}
                  height={height + 120}
                  initial={{ width: reveal ? 0 : plotW + 24 }}
                  animate={{ width: plotW + 24 }}
                  transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
                />
              </clipPath>
            </defs>

            {/* y axis (none over an all-zero line: there is no scale to read) */}
            {(allZero ? [] : ticks).map((t, i) => (
              <text
                key={t}
                x={0}
                y={y(t)}
                dominantBaseline="middle"
                fill="var(--ui-axis)"
                className="ui-figure"
                style={{ fontSize: 13, fontWeight: 500 }}
              >
                {axisLabels[i]}
              </text>
            ))}

            {allZero ? (
              // Nothing sold: a quiet dashed baseline, not a flat orange line.
              <line
                x1={axisWidth + 8}
                x2={axisWidth + 8 + plotW}
                y1={plotH - bottomPad}
                y2={plotH - bottomPad}
                stroke="var(--ui-axis)"
                strokeOpacity={0.7}
                strokeWidth={1}
                strokeDasharray="3 6"
              />
            ) : (
              <g clipPath={`url(#${id}-clip)`}>
                {n > 1 ? <path d={area} fill={`url(#${id}-fill)`} /> : null}
                {n > 1 ? (
                  <path
                    d={line}
                    fill="none"
                    stroke={flat ? "var(--ui-chart-top)" : `url(#${id}-stroke)`}
                    strokeWidth={2.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null}
              </g>
            )}

            {/* x axis */}
            {xLabels.map(({ key, px, text }) => (
              <text
                key={key}
                x={px}
                y={height - 10}
                textAnchor={px - (axisWidth + 8) < 36 ? "start" : axisWidth + 8 + plotW - px < 36 ? "end" : "middle"}
                fill="var(--ui-axis)"
                style={{ fontSize: 13, fontWeight: 500 }}
              >
                {text}
              </text>
            ))}

            {/* crosshair, from the bubble down to the axis, and the glowing dot */}
            {hp ? (
              <g>
                <line
                  x1={hp[0]}
                  x2={hp[0]}
                  y1={Math.max(0, hp[1] - 30)}
                  y2={plotH}
                  stroke="#ffffff"
                  strokeOpacity={0.4}
                  strokeWidth={1}
                  strokeDasharray="2 4"
                />
                <circle cx={hp[0]} cy={hp[1]} r={14} fill={`url(#${id}-glow)`} />
                <circle cx={hp[0]} cy={hp[1]} r={5} fill="var(--ui-chart-top)" />
                <circle cx={hp[0]} cy={hp[1]} r={2.5} fill="#ffffff" />
              </g>
            ) : null}
          </svg>
        ) : null}

        {/* The white bubble. */}
        {hp && at !== null ? (
          <div
            className="pointer-events-none absolute z-[1] flex -translate-x-1/2 -translate-y-full items-baseline gap-1.5 rounded-[10px] bg-white px-2.5 py-[7px] leading-none whitespace-nowrap text-[#121418] shadow-[0_8px_24px_-6px_rgb(0_0_0/0.6)]"
            style={{ left: Math.max(axisWidth + 48, Math.min(W - 48, hp[0])), top: Math.max(4, hp[1] - 28) }}
          >
            <span className="ui-figure text-[14px] font-semibold">{formatValue(values[at]!)}</span>
            {note ? <span className="text-[12px] font-medium text-[#6b6e76]">{note(data[at]!)}</span> : null}
          </div>
        ) : null}

      </div>
      {/* Outside the chart's image role, so it can hold buttons. */}
      {allZero && empty ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 grid place-items-center px-4 text-center text-[14px] text-ui-muted"
          style={{ bottom: X_AXIS + 12, paddingLeft: axisWidth + 8 }}
        >
          <div className="pointer-events-auto">{empty}</div>
        </div>
      ) : null}
      {/* The hovered value, for screen readers. */}
      <p className="sr-only" aria-live="polite">
        {hover !== null && data[hover] ? `${formatTime(data[hover]!.t)}: ${formatValue(data[hover]!.value)}` : ""}
      </p>
    </div>
  );
}
