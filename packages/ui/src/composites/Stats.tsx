import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";

/* ── StatTile ────────────────────────────────────────────────────────────── */

export type StatTileProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  value: ReactNode;
  label: ReactNode;
  /** Colour the value: `up` for ref B's green "+$850". */
  tone?: "default" | "up" | "down" | "lime";
  /** `value-first` (ref B: "8 / Owned") or `label-first` (ref C: "Live price / $128.06"). */
  order?: "value-first" | "label-first";
  /** `raised` inside a card, `surface` on the ground, `sunken` for ref C's grey tiles on white. */
  variant?: "surface" | "raised" | "sunken";
};

const TILE_BG = { surface: "bg-ui-surface-1", raised: "bg-ui-surface-2", sunken: "bg-ui-canvas" } as const;

const VALUE_TONE = {
  default: "text-ui-text",
  up: "text-ui-up",
  down: "text-ui-down",
  lime: "text-ui-lime",
};

/**
 * One figure and its label on a 20px tile.
 *
 * ```tsx
 * <StatTile value="8" label="On time" />
 * <StatTile value="+$850" label="Saved" tone="up" />
 * ```
 */
export function StatTile({
  value,
  label,
  tone = "default",
  order = "value-first",
  variant = "raised",
  className,
  ...props
}: StatTileProps) {
  const v = (
    <div className={cn("ui-figure truncate text-[20px] leading-tight font-semibold tracking-[-0.02em]", VALUE_TONE[tone])}>
      {value}
    </div>
  );
  const l = <div className="truncate text-[14px] text-ui-muted">{label}</div>;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-ui-tile px-4 py-4 font-satoshi",
        TILE_BG[variant],
        className,
      )}
      {...props}
    >
      {order === "value-first" ? (
        <>
          {v}
          {l}
        </>
      ) : (
        <>
          {l}
          {v}
        </>
      )}
    </div>
  );
}

/* ── KeyValueGrid ────────────────────────────────────────────────────────── */

export type KeyValue = { label: ReactNode; value: ReactNode; key?: string };

export type KeyValueGridProps = Omit<HTMLAttributes<HTMLDListElement>, "children"> & {
  items: KeyValue[];
  columns?: 2 | 3 | 4;
  variant?: "surface" | "raised" | "sunken";
};

const COLS = { 2: "grid-cols-2", 3: "grid-cols-2 sm:grid-cols-3", 4: "grid-cols-2 lg:grid-cols-4" };

/**
 * Ref C's grid of label-over-value tiles.
 *
 * ```tsx
 * <KeyValueGrid items={[{ label: "Amount", value: "$120.00" }, { label: "Pay in 4", value: "$30.00 × 4" }]} />
 * ```
 */
export function KeyValueGrid({ items, columns = 2, variant = "raised", className, ...props }: KeyValueGridProps) {
  return (
    <dl className={cn("grid gap-3 font-satoshi", COLS[columns], className)} {...props}>
      {items.map((it, i) => (
        <div
          key={it.key ?? i}
          className={cn(
            "flex min-w-0 flex-col gap-1 rounded-ui-tile px-4 py-3.5",
            TILE_BG[variant],
          )}
        >
          <dt className="truncate text-[13px] text-ui-muted">{it.label}</dt>
          <dd className="ui-figure truncate text-[17px] leading-snug font-medium text-ui-text">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── DetailsList ─────────────────────────────────────────────────────────── */

export type DetailsListProps = Omit<HTMLAttributes<HTMLDListElement>, "children"> & {
  items: KeyValue[];
  /** `raised` or `sunken` (ref C's grey panel on white); `plain`: rows only, for inside another card. */
  variant?: "raised" | "surface" | "sunken" | "plain";
  size?: "sm" | "md";
  /** Long labels (sentences) wrap and the values never truncate: for reasons with points. */
  wrapLabels?: boolean;
};

/**
 * Ref C's details: label on the left, value on the right, hairlines between.
 *
 * ```tsx
 * <DetailsList items={[{ label: "Merchant", value: "Blue Bottle" }, { label: "Order", value: "#4821" }]} />
 * ```
 */
export function DetailsList({ items, variant = "raised", size = "md", wrapLabels = false, className, ...props }: DetailsListProps) {
  return (
    <dl
      className={cn(
        "font-satoshi",
        variant === "raised" && "rounded-ui-tile bg-ui-surface-2 px-5 py-1",
        variant === "surface" && "rounded-ui-tile bg-ui-surface-1 px-5 py-1",
        variant === "sunken" && "rounded-ui-tile bg-ui-canvas px-5 py-1",
        className,
      )}
      {...props}
    >
      {items.map((it, i) => (
        <div
          key={it.key ?? i}
          className={cn(
            "flex items-center justify-between gap-6 border-b border-ui-hairline-strong last:border-b-0",
            size === "sm" ? "min-h-11 text-[14px]" : "min-h-[52px] text-[16px]",
          )}
        >
          <dt className={cn("text-ui-muted", wrapLabels ? "min-w-0 py-2.5 leading-snug" : "shrink-0")}>{it.label}</dt>
          <dd className={cn("ui-figure text-right text-ui-text", wrapLabels ? "shrink-0" : "min-w-0 truncate")}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
