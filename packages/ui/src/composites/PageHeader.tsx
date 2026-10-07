import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";

export type PageHeaderProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  /** A small line above the title ("Good morning, Oat & Ember"). */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** One or two lines under the title. */
  description?: ReactNode;
  /** The page's buttons, right-aligned (below the title on narrow screens). */
  actions?: ReactNode;
  /** Anything after the actions, like the avatar menu, kept on the title row. */
  trailing?: ReactNode;
  /**
   * `end` (default): the actions sit at the bottom right of the text block.
   * `title`: from 768px they sit on the title's line and the description runs
   * beneath, so a long description never pushes them down (a dashboard's
   * header, with the avatar menu in the corner).
   */
  actionsAlign?: "end" | "title";
};

/**
 * The top of a dashboard page: an eyebrow, a big title, a description, and
 * the page's actions on the right (ref C's "Hello, / Name" pairing, at page
 * scale).
 *
 * ```tsx
 * <PageHeader eyebrow="Good morning, Oat & Ember" title="Overview" actions={<Button>New link</Button>} />
 * ```
 */
export function PageHeader({ eyebrow, title, description, actions, trailing, actionsAlign = "end", className, ...props }: PageHeaderProps) {
  if (actionsAlign === "title") {
    return (
      <header
        className={cn("grid grid-cols-1 gap-y-4 font-satoshi md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:gap-x-6 md:gap-y-2", className)}
        {...props}
      >
        <div className="min-w-0 md:col-start-1 md:row-start-1">
          {eyebrow ? <p className="text-[15px] text-ui-muted">{eyebrow}</p> : null}
          <h1 className={cn("text-[32px] leading-[1.08] font-medium tracking-[-0.035em] text-ui-text md:text-[40px]", eyebrow && "mt-1")}>
            {title}
          </h1>
        </div>
        {description ? (
          <div className="order-1 -mt-2 max-w-[68ch] text-[15px] leading-[1.5] text-ui-muted md:order-none md:col-start-1 md:row-start-2 md:mt-0">
            {description}
          </div>
        ) : null}
        {actions || trailing ? (
          <div className="order-2 flex flex-wrap items-center gap-2 md:order-none md:col-start-2 md:row-start-1">
            {actions}
            {trailing}
          </div>
        ) : null}
      </header>
    );
  }
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-4 font-satoshi", className)} {...props}>
      <div className="min-w-0 flex-1 basis-[280px]">
        {eyebrow ? <p className="text-[15px] text-ui-muted">{eyebrow}</p> : null}
        <h1 className={cn("text-[32px] leading-[1.08] font-medium tracking-[-0.035em] text-ui-text md:text-[40px]", eyebrow && "mt-1")}>
          {title}
        </h1>
        {description ? <div className="mt-2 max-w-[68ch] text-[15px] leading-[1.5] text-ui-muted">{description}</div> : null}
      </div>
      {actions || trailing ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {trailing}
        </div>
      ) : null}
    </header>
  );
}
