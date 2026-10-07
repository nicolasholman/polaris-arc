import { ArrowDownRight, ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { formatPercent } from "../lib/format";
import { IconSlot } from "../lib/icon";
import { pressable } from "./Button";

/* ── Pill ────────────────────────────────────────────────────────────────── */

export type PillTone = "ink" | "black" | "surface" | "white" | "glass" | "outline" | "lime";
export type PillSize = "sm" | "md" | "lg";

const PILL_TONES: Record<PillTone, string> = {
  // Ref C: "Rewards", "USD" on light (ink), surface-3 on dark.
  ink: "bg-ui-ink text-ui-on-ink",
  // Ref A: "Main card" on the lime card.
  black: "bg-[#0f1011] text-white",
  surface: "bg-ui-surface-2 text-ui-text",
  // Ref C: "Market" on a grey card.
  white: "bg-white text-[#13141f]",
  // On a coloured card: ref B's delta chip, ref D's "+23%".
  glass: "bg-black/12 text-current backdrop-blur-sm",
  outline: "border border-ui-hairline-strong text-ui-text",
  lime: "bg-ui-lime text-ui-on-lime",
};

const PILL_SIZES: Record<PillSize, string> = {
  sm: "h-7 gap-1 px-2.5 text-[12px]",
  md: "h-9 gap-1.5 px-3.5 text-[14px]",
  lg: "h-11 gap-2 px-4 text-[15px]",
};

const PILL_ICON: Record<PillSize, number> = { sm: 14, md: 16, lg: 18 };

type PillOwnProps = {
  tone?: PillTone;
  size?: PillSize;
  icon?: ReactNode;
  /** A trailing chevron: the pill opens something ("Main card ▾"). */
  chevron?: boolean;
  trailing?: ReactNode;
};

export type PillProps = PillOwnProps &
  (
    | ({ onClick: ButtonHTMLAttributes<HTMLButtonElement>["onClick"] } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">)
    | ({ onClick?: undefined } & HTMLAttributes<HTMLSpanElement>)
  );

/**
 * A rounded label: "Main card ▾" (ref A), "Rewards" and "USD ⇄" (ref C).
 * With `onClick` it is a button.
 *
 * ```tsx
 * <Pill tone="black" chevron onClick={openAccounts}>Main account</Pill>
 * <Pill tone="ink" icon={<Gift />}>Rewards</Pill>
 * ```
 */
export const Pill = forwardRef<HTMLElement, PillProps>(function Pill(
  { tone = "surface", size = "md", icon, chevron = false, trailing, className, children, ...props },
  ref,
) {
  const classes = cn(
    "inline-flex shrink-0 items-center rounded-full font-satoshi leading-none font-medium whitespace-nowrap",
    PILL_TONES[tone],
    PILL_SIZES[size],
    className,
  );
  const inner = (
    <>
      {icon ? <IconSlot size={PILL_ICON[size]}>{icon}</IconSlot> : null}
      <span>{children}</span>
      {trailing}
      {chevron ? (
        <ChevronDown aria-hidden size={PILL_ICON[size]} strokeWidth={2} className="-mr-0.5 shrink-0 opacity-80" />
      ) : null}
    </>
  );
  if (typeof props.onClick === "function") {
    const { type, ...rest } = props as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button ref={ref as React.Ref<HTMLButtonElement>} type={type ?? "button"} className={cn(classes, pressable)} {...rest}>
        {inner}
      </button>
    );
  }
  return (
    <span ref={ref as React.Ref<HTMLSpanElement>} className={classes} {...(props as HTMLAttributes<HTMLSpanElement>)}>
      {inner}
    </span>
  );
});

/* ── Chip ────────────────────────────────────────────────────────────────── */

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  selected?: boolean;
  icon?: ReactNode;
  /** A trailing count ("Pending 3"). */
  count?: number;
  /** `plain` (ref C's timeframe chips), `outline` (filter chips), `solid`, or `pill` (ref E's option chips). */
  variant?: "plain" | "outline" | "solid" | "pill";
  size?: "sm" | "md";
  chevron?: boolean;
};

/**
 * A selectable chip. Unselected it is bare text; selected it becomes a pill
 * (ref C's "5m 15m 30m | 5h"). `outline` is the filter-chip look.
 *
 * ```tsx
 * <Chip selected={range === "1W"} onClick={() => setRange("1W")}>1W</Chip>
 * <Chip variant="outline" count={3}>Pending</Chip>
 * ```
 */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected = false, icon, count, variant = "plain", size = "md", chevron = false, className, children, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      // A radio or a tab says it is chosen with aria-checked / aria-selected;
      // aria-pressed is only allowed on a plain toggle button.
      aria-pressed={props.role === "radio" || props.role === "tab" ? undefined : selected}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-satoshi leading-none font-medium whitespace-nowrap",
        pressable,
        size === "sm" ? "h-8 gap-1 px-3 text-[13px]" : "h-9 gap-1.5 px-3.5 text-[14px]",
        variant === "plain" &&
          (selected ? "bg-ui-surface-3 text-ui-text" : "text-ui-muted hover:text-ui-text"),
        variant === "outline" &&
          (selected
            ? "border border-transparent bg-ui-ink text-ui-on-ink"
            : "border border-ui-hairline-strong text-ui-text hover:bg-ui-surface-2"),
        variant === "solid" &&
          (selected ? "bg-ui-lime text-ui-on-lime" : "bg-ui-surface-2 text-ui-text hover:bg-ui-surface-3"),
        // Ref E: an option chip. On: the lime button's fill with a check, so
        // a choice reads as chosen at a glance; off: a hairline and muted
        // text, and hovering only brightens the hairline (never looking chosen).
        variant === "pill" &&
          (selected
            ? "border border-transparent bg-ui-lime-button pl-2.5 text-[#121418]"
            : "border border-ui-hairline-strong text-ui-muted hover:border-ui-muted"),
        className,
      )}
      {...props}
    >
      {icon ? (
        <IconSlot size={size === "sm" ? 14 : 16}>{icon}</IconSlot>
      ) : variant === "pill" && selected ? (
        <Check aria-hidden size={size === "sm" ? 14 : 15} strokeWidth={2.5} className="shrink-0" />
      ) : null}
      {children}
      {typeof count === "number" ? (
        <span
          className={cn(
            "ui-figure ml-0.5 rounded-full px-1.5 py-0.5 text-[11px] leading-none",
            selected ? "bg-white/15" : "bg-ui-surface-3 text-ui-muted",
          )}
        >
          {count}
        </span>
      ) : null}
      {chevron ? <ChevronDown aria-hidden size={14} strokeWidth={2} className="-mr-1 opacity-70" /> : null}
    </button>
  );
});

/* ── DeltaBadge ──────────────────────────────────────────────────────────── */

export type DeltaBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  /** The change in percent: 2.1 means +2.1%. */
  value: number;
  /** An amount in front of the percent: "↗ $1,205.50 (+1.76%)" (ref B). */
  amount?: string;
  /**
   * `text`: "▲ 3.25%" in green or red (ref B tiles).
   * `chip`: a translucent pill on a coloured card (refs B, D).
   * `soft`: a tinted pill on a surface.
   */
  variant?: "text" | "chip" | "soft";
  /** A trailing note: "From last week" (ref A). */
  note?: string;
  decimals?: number;
  size?: "sm" | "md";
  /** `auto`: green up, red down. `current`: the text colour, for white-on-purple (ref A). */
  tone?: "auto" | "current";
};

/**
 * An up or down change. Direction comes from the sign.
 *
 * ```tsx
 * <DeltaBadge value={3.25} />
 * <DeltaBadge value={1.76} amount="$1,205.50" variant="chip" />
 * <DeltaBadge value={10.08} note="From last week" />
 * ```
 */
export function DeltaBadge({
  value,
  amount,
  variant = "text",
  note,
  decimals = 2,
  size = "md",
  tone = "auto",
  className,
  ...props
}: DeltaBadgeProps) {
  const up = value >= 0;
  const pct = formatPercent(value, { decimals });
  const label = `${up ? "Up" : "Down"} ${Math.abs(value).toFixed(decimals)} percent${amount ? `, ${amount}` : ""}`;
  const text = size === "sm" ? "text-[12px]" : "text-[14px]";

  if (variant === "chip") {
    const Arrow = up ? ArrowUpRight : ArrowDownRight;
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          "ui-figure inline-flex h-8 items-center gap-1.5 rounded-full bg-black/12 px-3 leading-none font-medium text-current",
          text,
          className,
        )}
        {...props}
      >
        {amount ? <Arrow aria-hidden size={16} strokeWidth={1.75} className="-ml-0.5 opacity-90" /> : null}
        <span aria-hidden>{amount ? `${amount} (${pct})` : pct}</span>
      </span>
    );
  }

  if (variant === "soft") {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          "ui-figure inline-flex h-7 items-center gap-1 rounded-full px-2.5 leading-none font-medium",
          text,
          up ? "bg-ui-up/12 text-ui-up" : "bg-ui-down/12 text-ui-down",
          className,
        )}
        {...props}
      >
        <Triangle up={up} />
        <span aria-hidden>{amount ? `${amount} (${pct})` : pct.replace(/^[+-]/, "")}</span>
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={label + (note ? `, ${note}` : "")}
      className={cn("ui-figure inline-flex items-center gap-1 leading-none font-medium whitespace-nowrap", text, className)}
      {...props}
    >
      <span
        aria-hidden
        className={cn("inline-flex items-center gap-1", tone === "current" ? "text-current" : up ? "text-ui-up" : "text-ui-down")}
      >
        <Triangle up={up} />
        {amount ? `${amount} (${pct})` : pct.replace(/^[+-]/, "")}
      </span>
      {note ? (
        <span aria-hidden className={cn("ml-1 font-normal", tone === "current" ? "" : "opacity-60")}>
          {note}
        </span>
      ) : null}
    </span>
  );
}

function Triangle({ up }: { up: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 10 8" width="9" height="7" className={cn("shrink-0", !up && "rotate-180")}>
      <path d="M5 0.6 9.4 7.4H0.6Z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Badge ───────────────────────────────────────────────────────────────── */

export type BadgeTone = "neutral" | "lime" | "purple" | "up" | "down" | "warn" | "info" | "ink";

const BADGE_TONES: Record<BadgeTone, { box: string; dot: string }> = {
  neutral: { box: "bg-ui-surface-3 text-ui-muted", dot: "bg-ui-muted" },
  lime: { box: "bg-ui-lime/18 text-ui-text", dot: "bg-ui-lime" },
  purple: { box: "bg-ui-purple/16 text-ui-purple-text", dot: "bg-ui-purple" },
  up: { box: "bg-ui-up/12 text-ui-up", dot: "bg-ui-up" },
  down: { box: "bg-ui-down/12 text-ui-down", dot: "bg-ui-down" },
  warn: { box: "bg-[#f5a524]/16 text-ui-warn", dot: "bg-[#f5a524]" },
  info: { box: "bg-ui-blue/20 text-ui-info", dot: "bg-ui-blue" },
  ink: { box: "bg-ui-ink text-ui-on-ink", dot: "bg-ui-on-ink" },
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /** A leading status dot. */
  dot?: boolean;
  size?: "sm" | "md";
};

/**
 * A small status label for tables and rows: Paid, Pending, Overdue.
 *
 * ```tsx
 * <Badge tone="up" dot>Paid</Badge>
 * <Badge tone="warn">Retrying</Badge>
 * ```
 */
export function Badge({ tone = "neutral", dot = false, size = "md", className, children, ...props }: BadgeProps) {
  const t = BADGE_TONES[tone];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full font-satoshi leading-none font-medium whitespace-nowrap",
        size === "sm" ? "h-5 gap-1 px-2 text-[11px]" : "h-6 gap-1.5 px-2.5 text-[12px]",
        t.box,
        className,
      )}
      {...props}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 rounded-full", t.dot)} /> : null}
      {children}
    </span>
  );
}
