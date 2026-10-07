"use client";

import { PolarisMark } from "@polaris/brand";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import { Menu } from "../primitives/Menu";

/* ── Coins ──────────────────────────────────────────────────────────────── */

export type CoinTone = "lime" | "blue" | "purple" | "teal" | "orange" | "dark";

const COIN: Record<CoinTone, string> = {
  // The reference's "$" coin.
  lime: "bg-[#a9c350] text-white",
  // The reference's ETH coin.
  blue: "bg-[#6d86e9] text-white",
  purple: "bg-[#9a6ad6] text-white",
  teal: "bg-[#4fb3ac] text-white",
  orange: "bg-[#e9903f] text-white",
  dark: "bg-ui-surface-1 text-ui-text",
};

export type CoinProps = {
  tone?: CoinTone;
  /** Diameter in px. */
  size?: number;
  /** The glyph: a letter, "$", an icon or a mark. */
  children: ReactNode;
  /** Read out, when the coin stands alone; decorative otherwise. */
  label?: string;
  className?: string;
};

/**
 * A round coin: a flat colour with a white glyph, like the reference's ETH
 * and "$" coins.
 *
 * ```tsx
 * <Coin tone="blue">$</Coin>
 * ```
 */
export function Coin({ tone = "lime", size = 48, children, label, className }: CoinProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-full font-satoshi leading-none font-bold [&_svg]:shrink-0",
        COIN[tone],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.52) }}
    >
      {children}
    </span>
  );
}

/** The Polaris coin: the star, in white, on the reference's lime. */
export function PolarisCoin({ size = 48, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <Coin tone="lime" size={size} className={className} label={label}>
      <PolarisMark mono title="" fill="#ffffff" width={Math.round(size * 0.46)} height={Math.round(size * 0.52)} />
    </Coin>
  );
}

/** The dollar coin: "$" in white on the reference's blue. */
export function DollarCoin({ size = 48, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <Coin tone="blue" size={size} className={className} label={label}>
      <span className="-mt-[0.04em]">$</span>
    </Coin>
  );
}

export type CoinPairProps = {
  coins: ReactNode[];
  /** How far each coin tucks under the next, in px. */
  overlap?: number;
  className?: string;
};

/** Two (or more) coins overlapping, the first one in front: the reference's ETH over $. */
export function CoinPair({ coins, overlap = 8, className }: CoinPairProps) {
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center", className)}>
      {coins.map((c, i) => (
        <span key={i} className="relative inline-flex" style={{ marginLeft: i ? -overlap : 0, zIndex: coins.length - i }}>
          {c}
        </span>
      ))}
    </span>
  );
}

/* ── PairHeader ─────────────────────────────────────────────────────────── */

export type PairOption<T extends string> = { value: T; label: string; description?: string };

export type PairHeaderProps<T extends string> = {
  /** The overlapping coins on the left. */
  coins: ReactNode[];
  /** The pair's name ("ETH/USD", "Sales / USD"); with `options`, it opens a menu. */
  title: ReactNode;
  options?: PairOption<T>[];
  value?: T;
  onValueChange?: (value: T) => void;
  /** The menu's accessible name. */
  menuLabel?: string;
  /** On the right: the chart type toggle. */
  trailing?: ReactNode;
  /** The heading level of the title. */
  as?: "h1" | "h2" | "h3" | "p";
  /** Extra classes for the title (e.g. a smaller size on phones: `max-sm:text-[20px]`). */
  titleClassName?: string;
  className?: string;
};

/**
 * The chart's header: overlapping round coins, the pair's name with a
 * chevron (a dropdown of what to chart), and the chart type toggle on the
 * right.
 *
 * ```tsx
 * <PairHeader
 *   coins={[<PolarisCoin key="p" />, <DollarCoin key="d" />]}
 *   title="Sales / USD"
 *   options={[{ value: "sales", label: "Sales / USD" }, { value: "later", label: "Pay in 4 / USD" }]}
 *   value={metric}
 *   onValueChange={setMetric}
 *   trailing={<ChartTypeToggle value={type} onValueChange={setType} />}
 * />
 * ```
 */
export function PairHeader<T extends string>({
  coins,
  title,
  options,
  value,
  onValueChange,
  menuLabel = "Choose what to chart",
  trailing,
  as: Heading = "h2",
  titleClassName,
  className,
}: PairHeaderProps<T>) {
  const titleClass = cn("truncate font-satoshi text-[24px] leading-none font-medium tracking-[-0.02em] text-ui-text sm:text-[28px]", titleClassName);
  const heading = <Heading className={titleClass}>{title}</Heading>;
  return (
    <div className={cn("flex min-w-0 items-center gap-3 sm:gap-4", className)}>
      <CoinPair coins={coins} />
      {options && options.length > 1 ? (
        <>
        {/* The heading for assistive tech; the visible title is the menu's button (a heading can't sit inside a button). */}
        <Heading className="sr-only">{title}</Heading>
        <Menu
          label={`${menuLabel}: ${typeof title === "string" ? title : (options.find((o) => o.value === value)?.label ?? "")}`}
          align="start"
          width={260}
          // Shrinks with the row (the title truncates), so the chart toggle stays on screen at 375 px.
          className="min-w-0"
          triggerClassName="min-w-0 max-w-full rounded-[12px] active:scale-100"
          trigger={
            <span aria-hidden className="flex min-w-0 items-center gap-2.5 hover:opacity-90">
              <span className={titleClass}>{title}</span>
              <ChevronDown aria-hidden size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ui-muted" />
            </span>
          }
        >
          {options.map((o) => (
            <Menu.Item
              key={o.value}
              onSelect={() => onValueChange?.(o.value)}
              description={o.description}
              trailing={o.value === value ? <Check aria-hidden size={16} strokeWidth={2} className="text-ui-lime-text" /> : null}
              aria-current={o.value === value ? "true" : undefined}
            >
              {o.label}
            </Menu.Item>
          ))}
        </Menu>
        </>
      ) : (
        heading
      )}
      {trailing ? <div className="ml-auto flex shrink-0 items-center">{trailing}</div> : null}
    </div>
  );
}
