import { forwardRef, type ElementType, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";

export type PanelCardProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Top right: a "See all" link, a pill, an icon square. */
  action?: ReactNode;
  /** Beside the title (a Sample chip). */
  badge?: ReactNode;
  /** `outline`: the summary card's hairline border on the panel. `filled`: a #1D2129 card. */
  variant?: "outline" | "filled";
  padding?: "md" | "lg";
  headingLevel?: "h2" | "h3";
  as?: ElementType;
};

/**
 * A card in ref E's language for everything the reference doesn't show
 * (charts, feeds, settings): the outlined summary card's border and corners,
 * or the stacked cards' #1D2129 fill, with a title row.
 *
 * ```tsx
 * <PanelCard title="Customers this week" action={<SeeAll />}>…</PanelCard>
 * ```
 */
export const PanelCard = forwardRef<HTMLElement, PanelCardProps>(function PanelCard(
  { title, subtitle, action, badge, variant = "outline", padding = "lg", headingLevel: H = "h2", as: Comp = "section", className, children, ...props },
  ref,
) {
  return (
    <Comp
      ref={ref}
      className={cn(
        "relative flex min-w-0 flex-col rounded-ui-panel font-satoshi text-ui-text",
        variant === "outline" ? "border border-ui-hairline-strong" : "bg-ui-surface-1",
        padding === "lg" ? "p-5 sm:p-6" : "p-4 sm:p-5",
        className,
      )}
      {...props}
    >
      {title || action ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <div className="flex flex-wrap items-center gap-2">
                <H className="truncate text-[18px] leading-tight font-medium tracking-[-0.015em]">{title}</H>
                {badge}
              </div>
            ) : null}
            {subtitle ? <p className="mt-1 text-[14px] leading-snug text-ui-muted">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </Comp>
  );
});
