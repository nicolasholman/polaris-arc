"use client";

import { CandlestickChart, ChartSpline } from "lucide-react";
import { useId, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { pressable } from "../primitives/Button";
import { IconSquareButton } from "./Buttons";

/* ── DeltaChip ───────────────────────────────────────────────────────────── */

export type DeltaChipProps = HTMLAttributes<HTMLSpanElement> & {
  /** The change in percent: 3.27 reads "+3.27%". Null shows `label` alone. */
  value: number | null;
  /** After the figure: "today", "this week". */
  suffix?: string;
  /** Replaces the figure (e.g. "New" when there is nothing to compare with). */
  label?: ReactNode;
  /** `soft` beside the big figure; `strong` in the balance card (a lighter lime ground). */
  variant?: "soft" | "strong";
  size?: "sm" | "md";
  decimals?: number;
  /**
   * Which way is good news. `up` (the default): gains lime, losses coral.
   * `down`, for money going out (spending): a fall is lime and a rise amber.
   */
  goodWhen?: "up" | "down";
};

/**
 * The reference's delta chip: "+3,27% today" in lime on a dark lime pill
 * beside the big figure, "+7.45%" in the balance card. Losses turn coral; no
 * change at all (0.00%) is a quiet grey.
 *
 * ```tsx
 * <DeltaChip value={3.27} suffix="today" />
 * <DeltaChip value={7.45} variant="strong" />
 * <DeltaChip value={10.15} suffix="vs last week" goodWhen="down" />
 * ```
 */
export function DeltaChip({ value, suffix, label, variant = "soft", size = "md", decimals = 2, goodWhen = "up", className, ...props }: DeltaChipProps) {
  // Rounded as shown: "0.00%" is no change, whatever the sign underneath.
  const shown = value === null ? null : Number(value.toFixed(decimals));
  const tone =
    shown === null ? "good" : shown === 0 ? "flat" : (shown > 0) === (goodWhen === "up") ? "good" : goodWhen === "up" ? "bad" : "watch";
  const figure =
    label ?? (shown === null ? "—" : `${shown > 0 ? "+" : shown < 0 ? "−" : ""}${Math.abs(shown).toFixed(decimals)}%`);
  return (
    <span
      className={cn(
        "ui-figure inline-flex shrink-0 items-center gap-1 rounded-full font-satoshi font-medium whitespace-nowrap",
        size === "md" ? "h-9 px-3.5 text-[14px]" : "h-7 px-2.5 text-[12.5px]",
        tone === "bad"
          ? "bg-ui-pill-red text-ui-pill-red-text"
          : tone === "watch"
            ? "bg-ui-pill-amber text-ui-pill-amber-text"
            : tone === "flat"
              ? "bg-ui-pill-neutral text-ui-pill-neutral-text"
              : cn(variant === "strong" ? "bg-ui-lime-chip-strong" : "bg-ui-lime-chip", "text-ui-lime-text"),
        className,
      )}
      {...props}
    >
      {figure}
      {suffix ? <span>{suffix}</span> : null}
    </span>
  );
}

/* ── StatusPill ──────────────────────────────────────────────────────────── */

export type StatusPillTone = "lime" | "purple" | "teal" | "amber" | "red" | "neutral";

const PILL: Record<StatusPillTone, string> = {
  lime: "bg-ui-pill-lime text-ui-pill-lime-text",
  purple: "bg-ui-pill-purple text-ui-pill-purple-text",
  teal: "bg-ui-pill-teal text-ui-pill-teal-text",
  amber: "bg-ui-pill-amber text-ui-pill-amber-text",
  red: "bg-ui-pill-red text-ui-pill-red-text",
  neutral: "bg-ui-pill-neutral text-ui-pill-neutral-text",
};

export type StatusPillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusPillTone;
  size?: "sm" | "md";
  /** A small leading icon. */
  icon?: ReactNode;
};

/**
 * The table's status pills ("Limited", "Trending", "Rising"): a tinted
 * ground with pale text, fully round. Lime, purple and teal from the
 * reference; amber (retrying, at risk), red (failed) and neutral in the same
 * style.
 *
 * ```tsx
 * <StatusPill tone="lime">Paid</StatusPill>
 * <StatusPill tone="amber">Retrying</StatusPill>
 * ```
 */
export function StatusPill({ tone = "lime", size = "md", icon, className, children, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-satoshi font-medium whitespace-nowrap",
        size === "md" ? "h-9 px-4 text-[14px]" : "h-7 px-3 text-[12.5px]",
        PILL[tone],
        className,
      )}
      {...props}
    >
      {icon ? (
        <span aria-hidden className="inline-grid size-3.5 place-items-center [&_svg]:size-3.5 [&_svg]:stroke-[2]">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/* ── Roving focus for the small option groups ───────────────────────────── */

function useRoving<T extends string>(values: readonly T[], value: T, onChange: (v: T) => void) {
  const refs = useRef(new Map<T, HTMLButtonElement | null>());
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const i = values.indexOf(value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % values.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + values.length) % values.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = values.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const v = values[next]!;
    onChange(v);
    refs.current.get(v)?.focus();
  };
  const bind = (v: T) => (el: HTMLButtonElement | null) => {
    refs.current.set(v, el);
  };
  return { onKeyDown, bind };
}

/* ── TimeframeChips ─────────────────────────────────────────────────────── */

export type TimeframeChipsProps<T extends string> = {
  options: readonly T[] | readonly { value: T; label: ReactNode; title?: string }[];
  value: T;
  onValueChange: (value: T) => void;
  "aria-label"?: string;
  className?: string;
};

/**
 * "1h 24h 1w 1m": muted text chips, the active one white on a #1D2129
 * rounded square. A radio group: arrow keys move and select.
 *
 * ```tsx
 * <TimeframeChips options={["1h", "24h", "1w", "1m"]} value={tf} onValueChange={setTf} />
 * ```
 */
export function TimeframeChips<T extends string>({ options, value, onValueChange, className, ...rest }: TimeframeChipsProps<T>) {
  const list = options.map((o) => (typeof o === "string" ? { value: o as T, label: o as ReactNode, title: undefined } : o));
  const { onKeyDown, bind } = useRoving(
    list.map((o) => o.value),
    value,
    onValueChange,
  );
  return (
    <div role="radiogroup" aria-label={rest["aria-label"] ?? "Timeframe"} onKeyDown={onKeyDown} className={cn("flex items-center gap-1.5", className)}>
      {list.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={bind(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => onValueChange(o.value)}
            className={cn(
              "h-8 min-w-[44px] rounded-[10px] px-3 font-satoshi text-[14px] font-medium",
              pressable,
              on ? "bg-ui-surface-1 text-ui-text" : "text-ui-muted hover:text-ui-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── ChartTypeToggle ────────────────────────────────────────────────────── */

export type ChartType = "line" | "candles";

export type ChartTypeToggleProps = {
  value: ChartType;
  onValueChange: (value: ChartType) => void;
  className?: string;
};

/**
 * The two squares beside the pair: a line chart and candles. The active one
 * is the raised square with a lime icon; the other is outlined.
 *
 * ```tsx
 * <ChartTypeToggle value={type} onValueChange={setType} />
 * ```
 */
export function ChartTypeToggle({ value, onValueChange, className }: ChartTypeToggleProps) {
  const values = ["line", "candles"] as const;
  const { onKeyDown, bind } = useRoving<ChartType>(values, value, onValueChange);
  return (
    <div role="radiogroup" aria-label="Chart type" onKeyDown={onKeyDown} className={cn("flex items-center gap-2", className)}>
      {values.map((v) => {
        const on = v === value;
        return (
          <IconSquareButton
            key={v}
            ref={bind(v)}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            label={v === "line" ? "Line chart" : "Candles"}
            icon={v === "line" ? <ChartSpline /> : <CandlestickChart />}
            tone={on ? "solid" : "outline"}
            active={on}
            onClick={() => onValueChange(v)}
          />
        );
      })}
    </div>
  );
}

/* ── TextTabs ───────────────────────────────────────────────────────────── */

export type TextTabsProps<T extends string> = {
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onValueChange: (value: T) => void;
  "aria-label": string;
  /** Pass the panel's id per value so each tab points at what it shows. */
  panelId?: (value: T) => string;
  /** Tab ids, so a panel can be labelled by its tab. */
  tabId?: (value: T) => string;
  /** `lg` the reference's 20px; `md` 16px; `auto` 16px on phones, 20px from 640px. */
  size?: "md" | "lg" | "auto";
  className?: string;
};

/**
 * "BUY  SELL": uppercase words, the active one in lime, the other muted.
 * A real tablist (arrow keys, Home, End).
 *
 * ```tsx
 * <TextTabs aria-label="Money" options={[{ value: "withdraw", label: "Withdraw" }, { value: "request", label: "Request" }]} value={tab} onValueChange={setTab} />
 * ```
 */
export function TextTabs<T extends string>({ options, value, onValueChange, panelId, tabId, size = "lg", className, ...rest }: TextTabsProps<T>) {
  const auto = useId();
  const { onKeyDown, bind } = useRoving(
    options.map((o) => o.value),
    value,
    onValueChange,
  );
  return (
    <div
      role="tablist"
      aria-label={rest["aria-label"]}
      onKeyDown={onKeyDown}
      className={cn("flex min-w-0 items-center", size === "auto" ? "gap-4 sm:gap-6" : "gap-6", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={bind(o.value)}
            id={tabId ? tabId(o.value) : `${auto}-${o.value}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId?.(o.value)}
            tabIndex={on ? 0 : -1}
            onClick={() => onValueChange(o.value)}
            className={cn(
              "rounded-[8px] font-satoshi font-semibold tracking-[0.01em] uppercase transition-colors duration-200",
              "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus",
              size === "lg" ? "text-[20px] leading-none" : size === "auto" ? "text-[16px] leading-none sm:text-[20px]" : "text-[16px] leading-none",
              on ? "text-ui-lime-active" : "text-ui-muted hover:text-ui-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
