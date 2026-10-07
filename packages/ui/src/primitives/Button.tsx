import { Loader2 } from "lucide-react";
import { Children, cloneElement, forwardRef, isValidElement, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { Slot } from "../lib/slot";

/** Press, focus and disabled behaviour every pressable shares. */
export const pressable =
  "select-none transition-[transform,background-color,color,border-color,opacity,box-shadow] duration-200 ease-ui-spring active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40";

export type ButtonVariant =
  | "lime"
  | "lime-bright"
  | "white"
  | "dark"
  | "purple"
  | "violet"
  | "outline"
  | "ghost";

export type ButtonSize = "sm" | "md" | "lg" | "xl";

const VARIANTS: Record<ButtonVariant, string> = {
  // Ref A: the balance card's lime, the Send button.
  lime: "bg-ui-lime text-ui-on-lime hover:brightness-[1.04]",
  // Ref C: Buy, Top Up.
  "lime-bright": "bg-ui-lime-bright text-ui-on-lime hover:brightness-[1.04]",
  // Ref B: Get Started, Buy.
  white: "bg-white text-[#13141f] hover:bg-white/90",
  // Ref B Sell on dark (surface-3); ref C's ink on light.
  dark: "bg-ui-ink text-ui-on-ink hover:brightness-[1.15]",
  // Ref C: Sell, Receive (purple-deep).
  purple: "bg-ui-purple-deep text-white hover:brightness-[1.1]",
  // Ref A: the spending card's softer purple.
  violet: "bg-ui-purple text-white hover:brightness-[1.06]",
  outline: "border border-ui-hairline-strong bg-transparent text-ui-text hover:bg-ui-surface-2",
  ghost: "bg-transparent text-ui-text hover:bg-ui-surface-2",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-4 text-[14px]",
  md: "h-11 gap-2 px-5 text-[15px]",
  lg: "h-14 gap-2 px-7 text-[17px]",
  xl: "h-16 gap-2.5 px-8 text-[18px]",
};

const ROUNDED: Record<ButtonSize, string> = {
  sm: "rounded-[12px]",
  md: "rounded-[14px]",
  lg: "rounded-[18px]",
  xl: "rounded-[20px]",
};

const ICON_SIZE: Record<ButtonSize, number> = { sm: 16, md: 18, lg: 20, xl: 22 };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** `pill` (refs A, C) or `rounded` (ref B's 18px rectangles). */
  shape?: "pill" | "rounded";
  /** A lucide icon component or any node, before the label. */
  icon?: ReactNode;
  /** After the label. */
  iconRight?: ReactNode;
  /** Shows a spinner, keeps the width, and blocks presses. */
  loading?: boolean;
  /** Stretch to the container. */
  block?: boolean;
  /** Render the child element (a Next.js Link, an anchor) with the button's styles. */
  asChild?: boolean;
};

/**
 * The button. Lime, lime-bright, white, dark, purple, violet, outline and
 * ghost; four sizes; pill or rounded; an icon slot either side.
 *
 * ```tsx
 * <Button variant="lime" size="xl" block>Send</Button>
 * <Button variant="purple" icon={<ArrowDownLeft />}>Pay in 4</Button>
 * <Button asChild variant="dark"><Link href="/links/new">New link</Link></Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "lime",
    size = "md",
    shape = "pill",
    icon,
    iconRight,
    loading = false,
    block = false,
    asChild = false,
    className,
    children,
    disabled,
    type,
    ...props
  },
  ref,
) {
  const classes = cn(
    "relative inline-flex shrink-0 items-center justify-center font-satoshi leading-none font-medium tracking-[-0.01em] whitespace-nowrap [&_svg]:shrink-0",
    pressable,
    VARIANTS[variant],
    SIZES[size],
    shape === "pill" ? "rounded-full" : ROUNDED[size],
    block && "w-full",
    loading && "pointer-events-none",
    className,
  );

  if (asChild) {
    const child = Children.only(children);
    if (!isValidElement(child)) return null;
    const el = child as ReactElement<{ children?: ReactNode }>;
    return (
      <Slot className={classes} ref={ref as never} {...(props as Record<string, unknown>)}>
        {cloneElement(
          el,
          undefined,
          <>
            {icon ? <IconSlot size={ICON_SIZE[size]}>{icon}</IconSlot> : null}
            {el.props.children}
            {iconRight ? <IconSlot size={ICON_SIZE[size]}>{iconRight}</IconSlot> : null}
          </>,
        )}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled}
      aria-busy={loading || undefined}
      className={classes}
      {...props}
    >
      <span className={cn("inline-flex items-center justify-center gap-[inherit]", loading && "invisible")}>
        {icon ? <IconSlot size={ICON_SIZE[size]}>{icon}</IconSlot> : null}
        {children}
        {iconRight ? <IconSlot size={ICON_SIZE[size]}>{iconRight}</IconSlot> : null}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Loader2 size={ICON_SIZE[size]} strokeWidth={2} className="animate-spin motion-reduce:animate-none" aria-hidden />
          <span className="sr-only">Working</span>
        </span>
      ) : null}
    </button>
  );
});

/* ── IconButton ──────────────────────────────────────────────────────────── */

export type IconButtonTone = "surface" | "ink" | "outline" | "white" | "lime" | "purple" | "glass" | "ghost" | "black";
export type IconButtonSize = "sm" | "md" | "lg";

const ICON_TONES: Record<IconButtonTone, string> = {
  // Ref A: the bell on dark.
  surface: "bg-ui-surface-2 text-ui-text hover:bg-ui-surface-3",
  // Ref C: the black bell, share and filter circles on light.
  ink: "bg-ui-ink text-ui-on-ink hover:brightness-[1.15]",
  // Ref D: the outlined square with the dots.
  outline: "border border-ui-hairline-strong bg-transparent text-ui-text hover:bg-ui-surface-2",
  // Ref B: the active chart toggle.
  white: "bg-white text-[#13141f] hover:bg-white/90",
  lime: "bg-ui-lime text-ui-on-lime hover:brightness-[1.04]",
  purple: "bg-ui-purple text-white hover:brightness-[1.06]",
  // On a coloured card (ref B calendar in the purple chart card).
  glass: "bg-black/15 text-current hover:bg-black/25",
  // Ref A: the bare back chevron.
  ghost: "bg-transparent text-ui-text hover:bg-ui-surface-2",
  // Ref A: bolt and pencil on the lime card.
  black: "bg-[#0f1011] text-white hover:bg-black",
};

const ICON_SIZES: Record<IconButtonSize, { box: string; icon: number; square: string }> = {
  sm: { box: "size-8", icon: 16, square: "rounded-[10px]" },
  md: { box: "size-11", icon: 20, square: "rounded-[14px]" },
  lg: { box: "size-[52px]", icon: 22, square: "rounded-[16px]" },
};

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Required: what the button does, for screen readers and the tooltip. */
  label: string;
  /** The lucide icon (or any node). Lucide icons get 1.75 stroke. */
  icon: ReactNode;
  tone?: IconButtonTone;
  size?: IconButtonSize;
  /** `round` (refs A, C) or `square` (refs B, D). */
  shape?: "round" | "square";
  /** A small lime dot, for unread notifications. */
  dot?: boolean;
  asChild?: boolean;
  children?: ReactNode;
};

/**
 * A round or square icon-only button: the bell, back, share, calendar and
 * filter buttons across the references.
 *
 * ```tsx
 * <IconButton label="Notifications" icon={<Bell />} dot />
 * <IconButton label="Back" icon={<ChevronLeft />} shape="square" />
 * ```
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, tone = "surface", size = "md", shape = "round", dot = false, asChild = false, className, children, type, ...props },
  ref,
) {
  const s = ICON_SIZES[size];
  const classes = cn(
    "relative inline-grid shrink-0 place-items-center [&_svg]:shrink-0",
    pressable,
    s.box,
    shape === "round" ? "rounded-full" : s.square,
    ICON_TONES[tone],
    className,
  );
  const inner = (
    <>
      <IconSlot size={s.icon}>{icon}</IconSlot>
      {dot ? (
        <span
          aria-hidden
          className="absolute top-[22%] right-[22%] size-2 rounded-full bg-ui-lime ring-2 ring-ui-canvas"
        />
      ) : null}
    </>
  );
  if (asChild) {
    const child = Children.only(children);
    if (!isValidElement(child)) return null;
    return (
      <Slot className={classes} aria-label={label} title={label} ref={ref as never} {...(props as Record<string, unknown>)}>
        {cloneElement(child as ReactElement<{ children?: ReactNode }>, undefined, inner)}
      </Slot>
    );
  }
  return (
    <button ref={ref} type={type ?? "button"} aria-label={label} title={label} className={classes} {...props}>
      {inner}
    </button>
  );
});
