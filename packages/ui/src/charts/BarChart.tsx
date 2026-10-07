"use client";

import { motion } from "motion/react";
import { useRef, useState, type HTMLAttributes, type KeyboardEvent } from "react";

import { cn } from "../lib/cn";
import { formatCompact } from "../lib/format";
import { useControllable, useReducedMotionSafe } from "../lib/hooks";
import { niceTicks } from "./geometry";

export type Bar = { label: string; value: number; color?: string };

export type BarChartProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "onSelect"> & {
  data: Bar[];
  /** Height of the bar area (labels add about 28px). */
  height?: number;
  /** The top of the scale; defaults to a round number above the largest bar. */
  max?: number;
  /** Selected bar (pink, with the tooltip). Defaults to the largest. */
  selected?: number;
  defaultSelected?: number;
  onSelect?: (index: number) => void;
  formatValue?: (v: number) => string;
  formatTick?: (v: number) => string;
  /** The y-axis labels on the left (ref D's "40 K 20 K 0 K"). */
  showAxis?: boolean;
  /** Bars below this share of `max` use the low (olive) fill, like ref D's Mon and Fri. */
  lowShare?: number;
  animate?: boolean;
  /** What the chart shows, for screen readers. */
  label: string;
};

/** Ref D's fills on the dark panel; a theme can recolour them (ref E: olive bars, the lime selection). */
export const BAR_COLORS = {
  fill: "var(--ui-bar-fill, #4a6f5e)",
  low: "var(--ui-bar-low, #6f6e48)",
  selected: "var(--ui-bar-selected, var(--ui-pink))",
  track: "var(--ui-track)",
};

/**
 * Ref D's weekly bars: round tracks, fills from the bottom, the selected bar
 * in pink with a dashed guide, a marker and a white tooltip bubble. Hover,
 * press or arrow keys to select.
 *
 * ```tsx
 * <BarChart label="Customers this week" data={week} formatValue={(v) => `$ ${v.toLocaleString()}`} />
 * ```
 */
export function BarChart({
  data,
  height = 200,
  max,
  selected,
  defaultSelected,
  onSelect,
  formatValue = (v) => v.toLocaleString("en-US"),
  formatTick,
  showAxis = true,
  lowShare = 0.3,
  animate = true,
  label,
  className,
  ...props
}: BarChartProps) {
  // Hydration-safe: false until mounted, so the draw-in markup matches the server.
  const reduced = useReducedMotionSafe();
  const biggest = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -Infinity) ? i : best), 0);
  const [sel, setSel] = useControllable<number>({ value: selected, defaultValue: defaultSelected ?? biggest, onChange: onSelect });
  const [hover, setHover] = useState<number | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  const top = max ?? niceTicks(0, Math.max(1, ...data.map((d) => d.value)), 3).at(-1)!;
  const ticks = [top, top / 2, 0];
  // Ref D's axis: "40 K", "20 K", "0 K".
  const tick =
    formatTick ??
    ((v: number) => (top >= 1000 ? `${Number((v / 1000).toFixed(1))} K` : formatCompact(v, 0)));
  const current = hover ?? sel;
  const reveal = animate && !reduced;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = -1;
    if (e.key === "ArrowRight") next = Math.min(data.length - 1, sel + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, sel - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = data.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setSel(next);
    groupRef.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  };

  return (
    <div className={cn("flex gap-3 font-satoshi", className)} {...props}>
      {showAxis ? (
        <div aria-hidden className="relative w-9 shrink-0 text-[13px] text-ui-muted" style={{ height }}>
          {ticks.map((t, i) => (
            <span
              key={t}
              className="ui-figure absolute left-0 -translate-y-1/2 whitespace-nowrap"
              style={{ top: `${(i / (ticks.length - 1)) * 100}%` }}
            >
              {tick(t)}
            </span>
          ))}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div
          ref={groupRef}
          role="radiogroup"
          aria-label={label}
          onKeyDown={onKey}
          onPointerLeave={() => setHover(null)}
          className="flex items-stretch justify-between gap-2"
          style={{ height }}
        >
          {data.map((d, i) => {
            const share = Math.max(0, Math.min(1, d.value / top));
            const isSel = i === current;
            const fill = isSel ? BAR_COLORS.selected : (d.color ?? (share < lowShare ? BAR_COLORS.low : BAR_COLORS.fill));
            return (
              <button
                key={d.label}
                type="button"
                role="radio"
                aria-checked={i === sel}
                aria-label={`${d.label}: ${formatValue(d.value)}`}
                tabIndex={i === sel ? 0 : -1}
                onClick={() => setSel(i)}
                onPointerEnter={(e) => e.pointerType === "mouse" && setHover(i)}
                className="group relative flex flex-1 justify-center outline-none"
              >
                <span
                  className="relative h-full w-full max-w-[26px] overflow-hidden rounded-full group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ui-focus"
                  style={{ background: BAR_COLORS.track }}
                >
                  <motion.span
                    key={reveal ? "reveal" : "still"}
                    className="absolute inset-x-0 bottom-0 shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]"
                    style={{ background: fill }}
                    initial={reveal ? { height: "0%" } : false}
                    animate={{ height: `${share * 100}%` }}
                    transition={{ delay: reveal ? i * 0.05 : 0, type: "spring", stiffness: 180, damping: 24 }}
                  />
                  {isSel ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-1/2 w-0 -translate-x-1/2 border-l-[1.5px] border-dashed border-white/80"
                    />
                  ) : null}
                </span>
                {isSel ? (
                  <>
                    <span
                      aria-hidden
                      className="absolute left-1/2 z-[1] size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                      style={{ top: `${(1 - share) * 100}%`, background: BAR_COLORS.selected }}
                    />
                    <span
                      aria-hidden
                      className={cn(
                        "ui-figure pointer-events-none absolute z-[2] -translate-y-1/2 rounded-[10px] bg-white px-2.5 py-1.5 text-[13px] leading-none font-medium whitespace-nowrap text-[#13141f] shadow-[0_6px_16px_rgb(0_0_0/0.3)]",
                        i === 0 ? "left-[calc(50%+12px)]" : "right-[calc(50%+12px)]",
                      )}
                      style={{ top: `${(1 - share) * 100}%` }}
                    >
                      {formatValue(d.value)}
                    </span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
        <div aria-hidden className="mt-2.5 flex justify-between gap-2">
          {data.map((d, i) => (
            <span key={d.label} className={cn("flex-1 text-center text-[14px]", i === current ? "text-ui-text" : "text-ui-muted")}>
              {d.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
