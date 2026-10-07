import { forwardRef, type ElementType, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { pressable } from "../primitives/Button";
import { RowChevron } from "../primitives/Card";

export type ListRowProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  /** A lucide icon (drawn in a round well) or any node, like an <Avatar>. */
  icon?: ReactNode;
  /** Put `icon` in the round surface well (the default) or leave it bare. */
  well?: boolean;
  /**
   * Colour the well: `surface` (grey), `lime`, `purple`, `down` (a
   * destructive action), or ref E's status-pill tints (`tint-lime`,
   * `tint-purple`, `tint-teal`: a dark tinted ground, pale icon).
   */
  tone?: "surface" | "lime" | "purple" | "down" | "tint-lime" | "tint-purple" | "tint-teal";
  title: ReactNode;
  /** A line under the title. */
  description?: ReactNode;
  /** Right-hand content: a value, a <Toggle>, a <Badge>. */
  trailing?: ReactNode;
  /** Show the row chevron (rows that open something). Defaults to on for links and buttons without `trailing`. */
  chevron?: boolean;
  /** Makes the row a link. */
  href?: string;
  /** The link component for `href` (Next.js Link). */
  linkAs?: ElementType;
  /** Makes the row a button. */
  onClick?: () => void;
  disabled?: boolean;
  /** `plain` inside a ListGroup; `card` its own rounded surface (ref D). */
  variant?: "plain" | "card";
};

const WELL_TONES = {
  surface: "bg-ui-surface-3 text-ui-text",
  lime: "bg-ui-lime text-ui-on-lime",
  purple: "bg-ui-purple text-white",
  down: "bg-ui-down/15 text-ui-down",
  "tint-lime": "bg-ui-pill-lime text-ui-pill-lime-text",
  "tint-purple": "bg-ui-pill-purple text-ui-pill-purple-text",
  "tint-teal": "bg-ui-pill-teal text-ui-pill-teal-text",
};

/**
 * One row of a settings list, a menu or a notification feed: an icon well,
 * a title with a line under it, and a value, toggle or chevron on the right.
 * A link, a button or a static row.
 *
 * ```tsx
 * <ListGroup>
 *   <ListRow icon={<Bell />} title="Notifications" description="Payments due, money in" href="/notifications" linkAs={Link} />
 *   <ListRow icon={<ScanFace />} title="Face ID" description="Asked for every payment" trailing={<Badge tone="up">On</Badge>} />
 * </ListGroup>
 * ```
 */
export const ListRow = forwardRef<HTMLElement, ListRowProps>(function ListRow(
  {
    icon,
    well = true,
    tone = "surface",
    title,
    description,
    trailing,
    chevron,
    href,
    linkAs: LinkComp = "a",
    onClick,
    disabled = false,
    variant = "plain",
    className,
    ...props
  },
  ref,
) {
  const interactive = Boolean(href || onClick);
  const showChevron = chevron ?? (interactive && trailing === undefined);
  const body = (
    <>
      {icon ? (
        well ? (
          <span className={cn("grid size-11 shrink-0 place-items-center rounded-full", WELL_TONES[tone])}>
            <IconSlot size={20}>{icon}</IconSlot>
          </span>
        ) : (
          <span className="shrink-0">{icon}</span>
        )
      ) : null}
      <span className="min-w-0 flex-1 text-left">
        <span className={cn("block truncate text-[16px] leading-tight font-medium", tone === "down" ? "text-ui-down" : "text-ui-text")}>
          {title}
        </span>
        {description ? <span className="mt-1 block text-[13px] leading-snug text-ui-muted">{description}</span> : null}
      </span>
      {trailing !== undefined ? <span className="shrink-0 text-[15px] text-ui-muted">{trailing}</span> : null}
      {showChevron ? <RowChevron /> : null}
    </>
  );
  // Plain rows all share one box, 8px wider than the content on each side, so
  // a pressed row's rounded highlight never bends the group's hairline.
  const classes = cn(
    "flex items-center gap-3.5 font-satoshi",
    variant === "card"
      ? "min-h-16 w-full rounded-ui-row bg-ui-surface-2 px-4 py-3"
      : "relative -mx-2 min-h-[64px] w-[calc(100%+16px)] rounded-ui-row px-2 py-2.5",
    className,
  );
  const press = cn(
    pressable,
    "active:scale-[0.985]",
    variant === "card" ? "hover:bg-ui-surface-3" : "hover:bg-ui-surface-3/60",
  );
  if (href) {
    return (
      <LinkComp ref={ref} href={href} aria-disabled={disabled || undefined} className={cn(classes, press)} {...props}>
        {body}
      </LinkComp>
    );
  }
  if (onClick) {
    return (
      <button
        ref={ref as never}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(classes, press)}
        {...(props as HTMLAttributes<HTMLButtonElement>)}
      >
        {body}
      </button>
    );
  }
  return (
    <div ref={ref as never} className={classes} {...(props as HTMLAttributes<HTMLDivElement>)}>
      {body}
    </div>
  );
});

export type ListGroupProps = HTMLAttributes<HTMLDivElement> & {
  /** A small heading over the group ("Account"). */
  label?: ReactNode;
};

/**
 * Rows on one raised 20px tile, hairlines between them.
 *
 * ```tsx
 * <ListGroup label="Account"><ListRow … /><ListRow … /></ListGroup>
 * ```
 */
export function ListGroup({ label, className, children, ...props }: ListGroupProps) {
  return (
    <div className={cn("font-satoshi", className)} {...props}>
      {label ? <p className="mb-2 px-1 text-[14px] font-medium text-ui-muted">{label}</p> : null}
      <div className="rounded-ui-tile bg-ui-surface-2 px-4 py-1 [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-2 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-ui-hairline-strong [&>*+*]:before:content-['']">
        {children}
      </div>
    </div>
  );
}
