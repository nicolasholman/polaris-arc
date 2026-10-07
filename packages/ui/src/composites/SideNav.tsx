"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, type ElementType, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";

export type SideNavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  href: string;
  /** A small count or chip after the label (full width only). */
  badge?: ReactNode;
};

export type SideNavProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  items: SideNavItem[];
  /** The active item's key. */
  value: string;
  /** The link component (Next.js Link). */
  linkAs?: ElementType;
  /** The brand at the top at full width: the wordmark. */
  brand: ReactNode;
  /** The brand in the icon rail: the mark. */
  brandCompact: ReactNode;
  /** Where the brand links to. */
  brandHref?: string;
  brandLabel?: string;
  /** Pinned to the bottom at full width (a status card). */
  footer?: ReactNode;
  /** Pinned to the bottom in the icon rail. */
  footerCompact?: ReactNode;
  /** The navigation's accessible name. */
  "aria-label"?: string;
};

const SPRING = { type: "spring", stiffness: 520, damping: 40 } as const;

/**
 * The web dashboard's sidebar, on a dark surface card like the app's panels.
 * It is responsive in CSS alone (no layout flash): hidden below 768px, an
 * icon rail with tooltips from 768 to 1279px, and full width with labels from
 * 1280px. The active item is a lime pill that slides between items (ref C's
 * lime "Home" tab, ref A's lime circle in the rail).
 *
 * ```tsx
 * <SideNav items={nav} value="payments" linkAs={Link}
 *   brand={<Logo height={30} />} brandCompact={<LogoMark size={30} />} />
 * ```
 */
export function SideNav({
  items,
  value,
  linkAs: Link = "a",
  brand,
  brandCompact,
  brandHref = "/",
  brandLabel = "Home",
  footer,
  footerCompact,
  className,
  "aria-label": ariaLabel = "Main",
  ...props
}: SideNavProps) {
  const id = useId();
  const reduced = useReducedMotion();
  return (
    <aside
      className={cn("sticky top-0 hidden h-dvh shrink-0 p-3 font-satoshi md:block md:w-[88px] xl:w-[264px]", className)}
      {...props}
    >
      <div className="flex h-full flex-col rounded-ui-card bg-ui-surface-1 px-3 py-4 xl:px-4 xl:py-5">
        <Link
          href={brandHref}
          aria-label={brandLabel}
          className="mb-6 flex h-12 items-center justify-center rounded-[16px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus xl:mb-7 xl:justify-start xl:px-2"
        >
          <span className="hidden xl:flex xl:items-center">{brand}</span>
          <span className="flex xl:hidden">{brandCompact}</span>
        </Link>

        <nav aria-label={ariaLabel} className="flex-1">
          <ul className="flex flex-col gap-1.5">
            {items.map((it) => {
              const active = it.key === value;
              return (
                <li key={it.key} className="group/nav relative">
                  <Link
                    href={it.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-12 items-center justify-center gap-3 rounded-full text-[15px] font-medium transition-colors duration-200",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus",
                      "xl:justify-start xl:px-4",
                      active ? "text-ui-on-lime" : "text-ui-muted hover:bg-ui-surface-2 hover:text-ui-text",
                    )}
                  >
                    {active ? (
                      <motion.span
                        layoutId={`${id}-active`}
                        transition={reduced ? { duration: 0 } : SPRING}
                        className="absolute inset-0 rounded-full bg-ui-lime"
                      />
                    ) : null}
                    <IconSlot size={20} className="relative inline-grid shrink-0 place-items-center">
                      {it.icon}
                    </IconSlot>
                    <span className="relative hidden min-w-0 flex-1 truncate xl:block">{it.label}</span>
                    {it.badge ? <span className="relative hidden xl:block">{it.badge}</span> : null}
                    {/* The rail's label: read out always, shown as a tooltip on hover and focus. */}
                    <span className="sr-only xl:hidden">{it.label}</span>
                  </Link>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-[calc(100%+12px)] z-50 hidden -translate-y-1/2 rounded-full bg-ui-surface-3 px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-ui-text opacity-0 shadow-ui-pop transition-opacity duration-150 group-hover/nav:opacity-100 group-focus-within/nav:opacity-100 md:block xl:hidden"
                  >
                    {it.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </nav>

        {footer || footerCompact ? (
          <div className="mt-4">
            {footer ? <div className="hidden xl:block">{footer}</div> : null}
            {footerCompact ? <div className="flex justify-center xl:hidden">{footerCompact}</div> : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
