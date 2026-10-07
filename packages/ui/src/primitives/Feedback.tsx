import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";

/* ── Skeleton ────────────────────────────────────────────────────────────── */

export type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  width?: number | string;
  height?: number | string;
  /** `card` 28, `tile` 20, `row` 18, `pill` round, `text` 6, `circle`. */
  shape?: "card" | "tile" | "row" | "pill" | "text" | "circle";
};

const SHAPES: Record<NonNullable<SkeletonProps["shape"]>, string> = {
  card: "rounded-ui-card",
  tile: "rounded-ui-tile",
  row: "rounded-ui-row",
  pill: "rounded-full",
  text: "rounded-[6px]",
  circle: "rounded-full",
};

/**
 * A loading placeholder with a slow shimmer (still under reduced motion).
 *
 * ```tsx
 * <Skeleton shape="card" height={200} />
 * <Skeleton shape="circle" width={44} height={44} />
 * ```
 */
export function Skeleton({ width, height = 16, shape = "text", className, style, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-ui-shimmer bg-ui-surface-3 bg-[length:200%_100%] motion-reduce:animate-none",
        "bg-[linear-gradient(90deg,transparent_0%,color-mix(in_oklab,var(--ui-text)_6%,transparent)_50%,transparent_100%)]",
        SHAPES[shape],
        className,
      )}
      style={{ width, height, ...style }}
      {...props}
    />
  );
}

/** Lines of text-shaped skeletons, the last one shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}

/* ── IconDisc ───────────────────────────────────────────────────────────── */

export type IconDiscProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  icon: ReactNode;
  /** `sm` 48, `md` 56, `lg` 64 (a confirm or status sheet's lead). */
  size?: "sm" | "md" | "lg";
};

const DISC: Record<NonNullable<IconDiscProps["size"]>, { box: string; icon: number }> = {
  sm: { box: "size-12", icon: 20 },
  md: { box: "size-14", icon: 26 },
  lg: { box: "size-16", icon: 28 },
};

/**
 * The round icon well that leads a confirm, a status or an empty state:
 * one icon on surface-2. Decorative; say what it means in the text beside it.
 *
 * ```tsx
 * <IconDisc icon={<ScanFace />} />
 * ```
 */
export function IconDisc({ icon, size = "lg", className, ...props }: IconDiscProps) {
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-full bg-ui-surface-2 text-ui-text", DISC[size].box, className)}
      {...props}
    >
      <IconSlot size={DISC[size].icon}>{icon}</IconSlot>
    </span>
  );
}

/* ── EmptyState ─────────────────────────────────────────────────────────── */

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** A Button or two. */
  action?: ReactNode;
  size?: "sm" | "md";
};

/**
 * What a list shows when it has nothing yet: an icon well, a title, one
 * line, and the action that fills it.
 *
 * ```tsx
 * <EmptyState icon={<Link2 />} title="No payment links yet" description="Create one and share it anywhere." action={<Button>New link</Button>} />
 * ```
 */
export function EmptyState({ icon, title, description, action, size = "md", className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center font-satoshi",
        size === "sm" ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
        className,
      )}
      {...props}
    >
      {icon ? <IconDisc icon={icon} size={size === "sm" ? "sm" : "lg"} className="mb-1" /> : null}
      <h3 className={cn("font-medium tracking-[-0.015em] text-ui-text", size === "sm" ? "text-[16px]" : "text-[19px]")}>
        {title}
      </h3>
      {description ? <p className="max-w-[36ch] text-[14px] leading-[1.45] text-ui-muted">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
