import type { HTMLAttributes, ReactNode } from "react";

import { Sparkline } from "../charts/Sparkline";
import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { DeltaBadge } from "../primitives/Pill";

export type StatCardTone = "sage" | "pink" | "honey" | "sky" | "lilac" | "lime" | "surface";

/** Ref D's pastel cards darken towards the right edge, like a card in a carousel. */
const TONES: Record<Exclude<StatCardTone, "surface">, string> = {
  sage: "linear-gradient(100deg, #b0d2c2 0%, #afd1c1 58%, #86a697 84%, #6a8a7b 100%)",
  pink: "linear-gradient(100deg, #f8d2d1 0%, #f6cfce 58%, #d6adac 84%, #b89291 100%)",
  honey: "linear-gradient(100deg, #ffe3a8 0%, #fbdc9c 58%, #d9b877 84%, #b39359 100%)",
  sky: "linear-gradient(100deg, #cfe4f8 0%, #c5dbf2 58%, #a3bad3 84%, #8499b1 100%)",
  lilac: "linear-gradient(100deg, #e4c4ff 0%, #d8a8ff 58%, #b88bdd 84%, #9a70bd 100%)",
  lime: "linear-gradient(100deg, #b4f383 0%, #9cef5e 58%, #86cf4f 84%, #6fae3f 100%)",
};

export type StatCardProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  label: ReactNode;
  /** The figure, usually a <Money>. */
  value: ReactNode;
  icon?: ReactNode;
  /** Percent change: the "+23%" chip. */
  delta?: number;
  /** The trend under the figure. */
  spark?: number[];
  /** A line under the figure instead of (or as well as) the spark. */
  footer?: ReactNode;
  tone?: StatCardTone;
  size?: "md" | "lg";
};

/**
 * Ref D's Sales card: a pastel card with an icon tile, a label, a delta
 * chip, a big figure and a sparkline over a dotted baseline. `surface` is
 * the same card in the theme's surface colour.
 *
 * ```tsx
 * <StatCard tone="sage" icon={<Percent />} label="Sales" delta={23} value={<Money value={24575} decimals={0} spaced dim="none" />} spark={sales} />
 * ```
 */
export function StatCard({
  label,
  value,
  icon,
  delta,
  spark,
  footer,
  tone = "sage",
  size = "md",
  className,
  style,
  ...props
}: StatCardProps) {
  const pastel = tone !== "surface";
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-ui-card p-6 font-satoshi",
        pastel ? "text-[#13141f]" : "bg-ui-surface-1 text-ui-text shadow-ui-card",
        className,
      )}
      style={pastel ? { background: TONES[tone], ...style } : style}
      {...props}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon ? (
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-[8px]",
                pastel ? "bg-black/10" : "bg-ui-surface-2",
              )}
            >
              <IconSlot size={15}>{icon}</IconSlot>
            </span>
          ) : null}
          <span className="truncate text-[15px] font-medium">{label}</span>
        </div>
        {delta !== undefined ? (
          pastel ? (
            <DeltaBadge value={delta} variant="chip" decimals={0} size="sm" className="h-7 bg-black/10 px-2.5" />
          ) : (
            <DeltaBadge value={delta} variant="soft" decimals={1} size="sm" />
          )
        ) : null}
      </div>
      <div
        className={cn(
          "mt-3 leading-none font-bold tracking-[-0.03em]",
          size === "lg" ? "text-[48px]" : "text-[40px]",
        )}
      >
        {value}
      </div>
      {spark && spark.length > 1 ? (
        <Sparkline
          data={spark}
          height={size === "lg" ? 64 : 52}
          curve="linear"
          strokeWidth={2.25}
          baseline="avg"
          color={pastel ? "#13141f" : "var(--ui-purple-deep)"}
          className="mt-4"
        />
      ) : null}
      {footer ? <div className={cn("mt-3 text-[13px]", pastel ? "text-black/60" : "text-ui-muted")}>{footer}</div> : null}
    </div>
  );
}
