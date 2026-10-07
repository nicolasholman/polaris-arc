import { Plus } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { Sparkline } from "../charts/Sparkline";
import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { Avatar, type Pastel } from "../primitives/Avatar";
import { pressable } from "../primitives/Button";

/* ── QuickTransfer ───────────────────────────────────────────────────────── */

export type QuickTransferProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  people: { name: string; src?: string; tone?: Pastel }[];
  onAdd?: () => void;
  onSelect?: (person: { name: string }) => void;
  /** Names under the circles (ref A shows faces only). */
  showNames?: boolean;
  addLabel?: string;
};

/**
 * Ref A's quick transfer: a lime-ringed "+" and a rail of 64px faces.
 *
 * ```tsx
 * <QuickTransfer people={contacts} onAdd={newLink} onSelect={(p) => sendTo(p)} />
 * ```
 */
export function QuickTransfer({ people, onAdd, onSelect, showNames = false, addLabel = "Send by link", className, ...props }: QuickTransferProps) {
  return (
    <div
      className={cn("ui-no-scrollbar -mx-5 flex snap-x scroll-px-5 items-start gap-1 overflow-x-auto px-5 pb-1 font-satoshi", className)}
      {...props}
    >
      <div className="flex shrink-0 snap-start flex-col items-center gap-1.5 pr-1">
        <button
          type="button"
          aria-label={addLabel}
          title={addLabel}
          onClick={onAdd}
          className={cn("grid size-16 place-items-center rounded-full border-[1.5px] border-ui-lime text-ui-lime", pressable)}
        >
          <Plus aria-hidden size={26} strokeWidth={1.5} />
        </button>
        {showNames ? <span className="w-16 truncate text-center text-[12px] text-ui-muted">New</span> : null}
      </div>
      {people.map((p) => (
        <div key={p.name} className="flex shrink-0 snap-start flex-col items-center gap-1.5">
          <button
            type="button"
            aria-label={`Send to ${p.name}`}
            title={p.name}
            onClick={() => onSelect?.(p)}
            className={cn("rounded-full", pressable)}
          >
            <Avatar name={p.name} src={p.src} tone={p.tone} size="xl" decorative />
          </button>
          {showNames ? <span className="w-16 truncate text-center text-[12px] text-ui-muted">{p.name.split(" ")[0]}</span> : null}
        </div>
      ))}
    </div>
  );
}

/* ── AssetRow ────────────────────────────────────────────────────────────── */

export type AssetRowProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "value"> & {
  leading: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** The sparkline in the middle. */
  spark?: number[];
  /**
   * Instalment ticks in the sparkline's place: `done` paid in lime, the
   * `current` one (this row's payment) in white, the rest dim.
   */
  progress?: { done: number; total: number; current?: number };
  /** Colour of the sparkline and delta: follows the trend unless set. */
  trend?: "up" | "down" | "flat";
  value: ReactNode;
  /** Under the value: "+2.24%" or "3 of 4". */
  meta?: ReactNode;
  /** Fill under the sparkline (ref C). */
  sparkFill?: boolean;
  /** `raised` (surface-2) or `sunken` (ref C's grey rows on white). */
  variant?: "raised" | "sunken";
  static?: boolean;
};

/**
 * A watchlist row (refs B, C): logo, name, a sparkline, the value and its change.
 *
 * ```tsx
 * <AssetRow leading={<Avatar name="Oat & Ember" color="#c2410c" />} title="Oat & Ember" subtitle="Oct 12 · 3 of 4"
 *   spark={[30, 30, 30, 30]} value="$14.75" meta="$29.50 left" />
 * ```
 */
export function AssetRow({
  leading,
  title,
  subtitle,
  spark,
  progress,
  trend,
  value,
  meta,
  sparkFill = false,
  variant = "raised",
  static: isStatic = false,
  className,
  type,
  ...props
}: AssetRowProps) {
  const t = trend ?? (spark && spark.length > 1 ? (spark[spark.length - 1]! >= spark[0]! ? "up" : "down") : "flat");
  const color = t === "up" ? "var(--ui-up)" : t === "down" ? "var(--ui-down)" : "var(--ui-muted)";
  const body = (
    <>
      <span className="shrink-0">{leading}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[16px] leading-tight font-medium text-ui-text">{title}</span>
        {subtitle ? <span className="mt-1 block truncate text-[13px] leading-tight text-ui-muted">{subtitle}</span> : null}
      </span>
      {spark && spark.length > 1 ? (
        <Sparkline data={spark} color={color} height={30} width={64} strokeWidth={1.5} fill={sparkFill} className="shrink-0" />
      ) : progress ? (
        <span role="img" aria-label={`${progress.done} of ${progress.total} paid`} className="flex w-16 shrink-0 gap-1">
          {Array.from({ length: progress.total }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                i < progress.done ? "bg-ui-lime" : i === progress.current ? "bg-ui-text" : "bg-ui-surface-3",
              )}
            />
          ))}
        </span>
      ) : null}
      <span className="min-w-[72px] shrink-0 text-right">
        <span className="ui-figure block text-[16px] leading-tight font-medium text-ui-text">{value}</span>
        {meta ? (
          <span className="ui-figure mt-1 block text-[13px] leading-tight" style={{ color }}>
            {meta}
          </span>
        ) : null}
      </span>
    </>
  );
  const cls = cn(
    "flex w-full items-center gap-3.5 rounded-ui-row px-4 py-3.5 font-satoshi",
    variant === "sunken" ? "bg-ui-canvas" : "bg-ui-surface-2",
    className,
  );
  if (isStatic) return <div className={cls}>{body}</div>;
  return (
    <button
      type={type ?? "button"}
      className={cn(cls, pressable, "active:scale-[0.98]", variant === "sunken" ? "hover:bg-ui-surface-3" : "hover:bg-ui-surface-3")}
      {...props}
    >
      {body}
    </button>
  );
}

/* ── FeaturedTile ────────────────────────────────────────────────────────── */

export type FeaturedTileProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "value"> & {
  leading: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  value: ReactNode;
  /** Under the value: a DeltaBadge, "Next Oct 12". */
  meta?: ReactNode;
  /** Instalment ticks: 2 of 4 paid. */
  progress?: { done: number; total: number };
  /** A brand colour that tints the tile (ref B's red and blue tiles). */
  tint?: string;
};

/**
 * Ref B's featured tile, tinted by the brand: logo, name, a figure and a
 * change, with optional instalment ticks (Active plans).
 *
 * ```tsx
 * <FeaturedTile leading={<Avatar … />} title="Oat & Ember" subtitle="Pay in 4" value="$90.00" meta="Next Oct 12" progress={{ done: 2, total: 4 }} tint="#c2410c" />
 * ```
 */
export function FeaturedTile({ leading, title, subtitle, value, meta, progress, tint, className, style, type, ...props }: FeaturedTileProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "flex w-[168px] shrink-0 flex-col rounded-ui-tile bg-ui-surface-2 p-4 text-left font-satoshi",
        pressable,
        "active:scale-[0.97]",
        className,
      )}
      style={tint ? { background: `color-mix(in oklab, ${tint} 16%, var(--ui-surface-1))`, ...style } : style}
      {...props}
    >
      <span className="flex items-center gap-2.5">
        <span className="shrink-0">{leading}</span>
        <span className="min-w-0">
          <span className="block truncate text-[16px] leading-tight font-semibold text-ui-text">{title}</span>
          {subtitle ? (
            <span className={cn("block truncate text-[13px] leading-tight", tint ? "text-ui-text/70" : "text-ui-muted")}>{subtitle}</span>
          ) : null}
        </span>
      </span>
      <span className="ui-figure mt-5 block text-[20px] leading-tight font-medium tracking-[-0.02em] text-ui-text">{value}</span>
      {/* On a tinted tile the muted grey loses contrast; the text colour at 70% keeps AA. */}
      {meta ? <span className={cn("mt-1 block text-[13px]", tint ? "text-ui-text/70" : "text-ui-muted")}>{meta}</span> : null}
      {progress ? (
        <span
          role="img"
          aria-label={`${progress.done} of ${progress.total} paid`}
          className="mt-3 flex gap-1"
        >
          {Array.from({ length: progress.total }, (_, i) => (
            <span key={i} className={cn("h-1.5 flex-1 rounded-full", i < progress.done ? "bg-ui-lime" : "bg-ui-surface-3")} />
          ))}
        </span>
      ) : null}
    </button>
  );
}

/* ── TileButton ──────────────────────────────────────────────────────────── */

export type TileButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  label: string;
  /** Ref C: `ink` Send, `purple` Receive, `lime` Top Up; `surface` for more. */
  tone?: "ink" | "purple" | "lime" | "surface";
};

const TILE_TONES = {
  ink: "bg-ui-ink text-ui-on-ink",
  purple: "bg-ui-purple-deep text-white",
  lime: "bg-ui-lime-bright text-[#13141f]",
  surface: "bg-ui-surface-2 text-ui-text",
};

/**
 * Ref C's square action tiles: an icon over a label.
 *
 * ```tsx
 * <div className="grid grid-cols-3 gap-2"><TileButton tone="ink" icon={<ArrowUpRight />} label="Send" /></div>
 * ```
 */
export function TileButton({ icon, label, tone = "ink", className, type, ...props }: TileButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "flex h-[88px] min-w-0 flex-col items-center justify-center gap-3 rounded-[18px] font-satoshi text-[16px] leading-none font-medium",
        pressable,
        TILE_TONES[tone],
        className,
      )}
      {...props}
    >
      <IconSlot size={22}>{icon}</IconSlot>
      <span className="truncate">{label}</span>
    </button>
  );
}
