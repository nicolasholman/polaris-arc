import { ChevronRight } from "lucide-react";
import { forwardRef, type ElementType, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { Slot } from "../lib/slot";

/* ── ThemeScope ──────────────────────────────────────────────────────────── */

/** `ref-e` is ref E (LumaTrade): the merchant web app's dark theme on a lime canvas. */
export type Theme = "dark" | "light" | "ref-e";

export type ThemeScopeProps = HTMLAttributes<HTMLDivElement> & {
  theme: Theme;
  /** Also paint the theme's ground and set Satoshi (a page or screen root). */
  root?: boolean;
  asChild?: boolean;
};

/**
 * Switch the tokens for a subtree: a dark analytics panel inside the light
 * dashboard shell, or a light preview inside the dark app.
 *
 * ```tsx
 * <ThemeScope theme="light" root className="min-h-dvh">…</ThemeScope>
 * ```
 */
export const ThemeScope = forwardRef<HTMLDivElement, ThemeScopeProps>(function ThemeScope(
  { theme, root = false, asChild = false, className, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      ref={ref as never}
      data-theme={theme}
      className={cn("text-ui-text", root && "ui-root", className)}
      {...(props as Record<string, unknown>)}
    />
  );
});

/* ── Card ────────────────────────────────────────────────────────────────── */

export type CardVariant = "surface" | "raised" | "canvas" | "outline";
export type CardRadius = "card" | "tile" | "row";
export type CardPadding = "none" | "sm" | "md" | "lg";

const CARD_VARIANTS: Record<CardVariant, string> = {
  surface: "bg-ui-surface-1 shadow-ui-card",
  raised: "bg-ui-surface-2",
  // A dark analytics panel (ref D's black ground) when themed dark.
  canvas: "bg-ui-canvas",
  outline: "border border-ui-hairline bg-transparent",
};

const CARD_RADIUS: Record<CardRadius, string> = {
  card: "rounded-ui-card",
  tile: "rounded-ui-tile",
  row: "rounded-ui-row",
};

const CARD_PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6",
};

export type CardProps = HTMLAttributes<HTMLElement> & {
  variant?: CardVariant;
  radius?: CardRadius;
  padding?: CardPadding;
  /** Scope the card to a theme: `dark` makes a ref D panel inside the light shell. */
  theme?: Theme;
  as?: ElementType;
};

/**
 * The surface everything sits on. 28px radius, no shadow on dark (surfaces
 * separate by tone), a hairline-soft lift on light.
 *
 * ```tsx
 * <Card padding="lg">…</Card>
 * <Card theme="dark" variant="canvas" padding="lg">…analytics…</Card>
 * ```
 */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { variant = "surface", radius = "card", padding = "md", theme, as: Comp = "div", className, ...props },
  ref,
) {
  return (
    <Comp
      ref={ref}
      data-theme={theme}
      className={cn(
        "relative font-satoshi",
        theme && "text-ui-text",
        CARD_VARIANTS[variant],
        CARD_RADIUS[radius],
        CARD_PADDING[padding],
        className,
      )}
      {...props}
    />
  );
});

/* ── Tile ────────────────────────────────────────────────────────────────── */

export type TileProps = HTMLAttributes<HTMLElement> & {
  /** `surface` on the ground, `raised` inside a card (ref C's grey tiles on white). */
  variant?: "surface" | "raised" | "sunken";
  as?: ElementType;
};

/**
 * A smaller surface (20px radius): stat tiles, key-value tiles, featured tiles.
 *
 * ```tsx
 * <Tile variant="raised">…</Tile>
 * ```
 */
export const Tile = forwardRef<HTMLElement, TileProps>(function Tile(
  { variant = "surface", as: Comp = "div", className, ...props },
  ref,
) {
  return (
    <Comp
      ref={ref}
      className={cn(
        "relative rounded-ui-tile p-4 font-satoshi",
        variant === "surface" && "bg-ui-surface-1",
        variant === "raised" && "bg-ui-surface-2",
        variant === "sunken" && "bg-ui-canvas",
        className,
      )}
      {...props}
    />
  );
});

/* ── SectionHeader ───────────────────────────────────────────────────────── */

export type SectionHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  /** A line under the title ("Total Profit Growth of 26%", ref D). */
  subtitle?: ReactNode;
  /** "See all" as a link or a button. */
  actionLabel?: string;
  href?: string;
  onAction?: () => void;
  /** Anything else on the right: an IconButton, a Select. Wins over actionLabel. */
  action?: ReactNode;
  /** `md` (ref A, 18px), `lg` (refs C, D, 22px). */
  size?: "md" | "lg";
  /** Heading level. */
  as?: "h2" | "h3" | "h4";
};

/**
 * A section title with "See all" or an action on the right.
 *
 * ```tsx
 * <SectionHeader title="Recent transactions" actionLabel="See all" href="/activity" />
 * <SectionHeader title="Favorites" size="lg" action={<IconButton … />} />
 * ```
 */
export function SectionHeader({
  title,
  subtitle,
  actionLabel,
  href,
  onAction,
  action,
  size = "md",
  as: Heading = "h2",
  className,
  ...props
}: SectionHeaderProps) {
  const linkClass =
    "inline-flex items-center gap-0.5 rounded-full text-[15px] text-ui-muted transition-colors hover:text-ui-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus";
  return (
    <div className={cn("flex items-center justify-between gap-4 font-satoshi", className)} {...props}>
      <div className="min-w-0">
        <Heading
          className={cn(
            "truncate font-medium text-ui-text",
            size === "md" ? "text-[18px] tracking-[-0.015em]" : "text-[22px] tracking-[-0.02em]",
          )}
        >
          {title}
        </Heading>
        {subtitle ? <p className="mt-1 text-[14px] text-ui-muted">{subtitle}</p> : null}
      </div>
      {action ? (
        <div className="shrink-0">{action}</div>
      ) : actionLabel ? (
        href ? (
          <a href={href} className={linkClass}>
            {actionLabel}
          </a>
        ) : (
          <button type="button" onClick={onAction} className={linkClass}>
            {actionLabel}
          </button>
        )
      ) : null}
    </div>
  );
}

/** The row chevron, for rows that open something. */
export function RowChevron({ className }: { className?: string }) {
  return <ChevronRight aria-hidden size={18} strokeWidth={1.75} className={cn("shrink-0 text-ui-dim", className)} />;
}
