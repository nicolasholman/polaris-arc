"use client";

import { ArrowLeft, Bell, ChevronLeft } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useId, type ElementType, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { Avatar } from "../primitives/Avatar";
import { IconButton } from "../primitives/Button";
import { Logo, LogoMark } from "../primitives/Logo";

/* ── BottomNav ───────────────────────────────────────────────────────────── */

export type NavItem = { key: string; label: string; icon: ReactNode; href?: string };

export type BottomNavProps = Omit<HTMLAttributes<HTMLElement>, "onChange"> & {
  items: NavItem[];
  value: string;
  onValueChange?: (key: string) => void;
  /**
   * `icons`: ref A's glass pill of round buttons, the active one filled.
   * `labelled`: ref C's black pill, the active tab a lime pill with its label.
   */
  variant?: "icons" | "labelled";
  /** The active fill for `icons`: lime (ref A) or white (ref B). */
  activeTone?: "lime" | "white";
  /** Pin it to the bottom centre, above the home indicator. */
  floating?: boolean;
  /** The link component for items with `href` (Next.js Link). */
  linkAs?: ElementType;
  /** `sm` fits six 48px items on a 360px phone (the web dashboard); `md` is ref A's 56px. */
  size?: "md" | "sm";
};

const SPRING = { type: "spring", stiffness: 480, damping: 38 } as const;

/**
 * The floating tab bar in two variants.
 *
 * ```tsx
 * <BottomNav floating items={tabs} value="home" linkAs={Link} />
 * <BottomNav variant="labelled" items={tabs} value="home" onValueChange={setTab} />
 * ```
 */
export function BottomNav({
  items,
  value,
  onValueChange,
  variant = "icons",
  activeTone = "lime",
  floating = false,
  linkAs: Link = "a",
  size = "md",
  className,
  ...props
}: BottomNavProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const labelled = variant === "labelled";

  return (
    <nav
      aria-label="Main"
      className={cn(
        "font-satoshi",
        floating && "fixed inset-x-0 bottom-[max(12px,env(safe-area-inset-bottom))] z-40 flex justify-center px-4",
        className,
      )}
      {...props}
    >
      <ul
        className={cn(
          "flex items-center",
          labelled
            ? "h-[68px] w-full max-w-[360px] justify-between gap-1 rounded-full bg-[#13141f] p-2 shadow-ui-nav"
            : cn("rounded-full bg-ui-glass p-1.5 shadow-ui-nav backdrop-blur-xl", size === "sm" ? "gap-1" : "gap-1.5"),
        )}
      >
        {items.map((it) => {
          const active = it.key === value;
          const content = labelled ? (
            <>
              {active ? (
                <motion.span
                  layoutId={`${id}-active`}
                  transition={reduced ? { duration: 0 } : SPRING}
                  className="absolute inset-0 rounded-full bg-ui-lime-bright"
                />
              ) : null}
              <span className={cn("relative flex items-center gap-2", active ? "text-[#13141f]" : "text-[#9a9ba5]")}>
                <IconSlot size={24}>{it.icon}</IconSlot>
                {active ? <span className="text-[17px] font-medium">{it.label}</span> : <span className="sr-only">{it.label}</span>}
              </span>
            </>
          ) : (
            <>
              {active ? (
                <motion.span
                  layoutId={`${id}-active`}
                  transition={reduced ? { duration: 0 } : SPRING}
                  className={cn("absolute inset-0 rounded-full", activeTone === "lime" ? "bg-ui-lime" : "bg-white")}
                />
              ) : null}
              <span className={cn("relative", active ? "text-[#0f1011]" : "text-ui-muted")}>
                <IconSlot size={size === "sm" ? 20 : 22}>{it.icon}</IconSlot>
              </span>
              <span className="sr-only">{it.label}</span>
            </>
          );
          const cls = cn(
            "relative grid place-items-center rounded-full transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus",
            labelled ? (active ? "h-[52px] px-5" : "h-[52px] px-4 hover:text-white") : cn(size === "sm" ? "size-12" : "size-14", !active && "bg-ui-canvas/70 hover:bg-ui-surface-2"),
          );
          return (
            <li key={it.key}>
              {it.href ? (
                <Link
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  title={it.label}
                  onClick={() => onValueChange?.(it.key)}
                  className={cls}
                >
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  title={it.label}
                  onClick={() => onValueChange?.(it.key)}
                  className={cls}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ── AppHeader ───────────────────────────────────────────────────────────── */

export type AppHeaderProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  /** `brand`: the logo, bell and avatar (refs A, B). `greeting`: avatar and "Hello, name" with an ink bell (ref C). */
  variant?: "brand" | "greeting";
  name: string;
  avatarSrc?: string;
  greeting?: string;
  onBell?: () => void;
  unread?: boolean;
  onAvatar?: () => void;
  /** Replace the right-hand side. */
  trailing?: ReactNode;
  /** `brand` only: the star mark before the wordmark, like ref A's logo and name. */
  mark?: boolean;
  /** `brand` only: wrap the logo (a Next.js Link home, say). */
  logoHref?: string;
  /** The link component for `logoHref`. */
  linkAs?: ElementType;
};

/**
 * The top of a tab screen.
 *
 * ```tsx
 * <AppHeader name="Ana Ruiz" unread onBell={openNotifications} />
 * <AppHeader mark name="Ana Ruiz" logoHref="/" linkAs={Link} />
 * <AppHeader variant="greeting" name="Ana Ruiz" />
 * ```
 */
export function AppHeader({
  variant = "brand",
  name,
  avatarSrc,
  greeting = "Hello,",
  onBell,
  unread = false,
  onAvatar,
  trailing,
  mark = false,
  logoHref,
  linkAs: LinkComp = "a",
  className,
  ...props
}: AppHeaderProps) {
  const brand = mark ? (
    <span className="flex items-center gap-2">
      <LogoMark size={32} title="" />
      <Logo height={28} />
    </span>
  ) : (
    <Logo height={30} />
  );
  const avatar = onAvatar ? (
    <button type="button" onClick={onAvatar} aria-label="Account" className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus">
      <Avatar name={name} src={avatarSrc} size="md" decorative />
    </button>
  ) : (
    <Avatar name={name} src={avatarSrc} size="md" />
  );
  return (
    <header className={cn("flex h-16 items-center justify-between gap-3 font-satoshi", className)} {...props}>
      {variant === "brand" ? (
        <>
          {logoHref ? (
            <LinkComp
              href={logoHref}
              aria-label="Polaris, home"
              className="rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus"
            >
              {brand}
            </LinkComp>
          ) : (
            brand
          )}
          <div className="flex items-center gap-2.5">
            {trailing ?? (
              <>
                <IconButton label="Notifications" icon={<Bell />} tone="surface" dot={unread} onClick={onBell} />
                {avatar}
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-3">
            {avatar}
            <div className="min-w-0 leading-tight">
              <div className="text-[13px] text-ui-muted">{greeting}</div>
              <div className="truncate text-[17px] font-medium text-ui-text">{name}</div>
            </div>
          </div>
          {trailing ?? <IconButton label="Notifications" icon={<Bell />} tone="ink" dot={unread} onClick={onBell} />}
        </>
      )}
    </header>
  );
}

/* ── ScreenHeader ────────────────────────────────────────────────────────── */

export type ScreenHeaderProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode;
  subtitle?: ReactNode;
  /** A logo left of the title (ref B's ticker header). */
  logo?: ReactNode;
  onBack?: () => void;
  backHref?: string;
  /** The right-hand button (history, share, more). */
  action?: ReactNode;
  /** `plain` chevron (ref A), `square` button (ref B), `arrow` (ref C). */
  variant?: "plain" | "square" | "arrow";
};

/**
 * Back, a centred title, and one action.
 *
 * ```tsx
 * <ScreenHeader title="Send" onBack={back} action={<IconButton label="History" icon={<History />} tone="ghost" />} />
 * <ScreenHeader variant="arrow" title="Oat & Ember" subtitle="Order #4821" action={<IconButton label="Share" icon={<Share2 />} tone="ink" />} />
 * ```
 */
export function ScreenHeader({
  title,
  subtitle,
  logo,
  onBack,
  backHref,
  action,
  variant = "plain",
  className,
  ...props
}: ScreenHeaderProps) {
  const icon = variant === "arrow" ? <ArrowLeft /> : <ChevronLeft />;
  const tone = variant === "square" ? "surface" : "ghost";
  const back =
    onBack || backHref ? (
      backHref ? (
        <IconButton asChild label="Back" icon={icon} tone={tone} shape={variant === "square" ? "square" : "round"}>
          <a href={backHref} />
        </IconButton>
      ) : (
        <IconButton label="Back" icon={icon} tone={tone} shape={variant === "square" ? "square" : "round"} onClick={onBack} />
      )
    ) : (
      <span />
    );
  return (
    <header className={cn("grid h-16 grid-cols-[44px_1fr_44px] items-center gap-2 font-satoshi", className)} {...props}>
      <div className="-ml-1.5 flex">{back}</div>
      <div className="flex min-w-0 items-center justify-center gap-2.5">
        {logo ? <span className="shrink-0">{logo}</span> : null}
        <div className={cn("min-w-0", logo ? "text-left" : "text-center")}>
          <h1 className="truncate text-[20px] leading-tight font-medium tracking-[-0.02em] text-ui-text">{title}</h1>
          {subtitle ? <p className="truncate text-[13px] leading-tight text-ui-muted">{subtitle}</p> : null}
        </div>
      </div>
      <div className="-mr-1.5 flex justify-end">{action}</div>
    </header>
  );
}
