import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import { Skeleton } from "../primitives/Feedback";
import { DeltaChip } from "./Chips";

export type FigureRowProps = {
  /** The big figure (a `<Money>`); undefined while it loads. */
  value: ReactNode | undefined;
  /** The chip's change in percent; null shows `deltaLabel` alone; undefined, no chip. */
  delta?: number | null;
  /** After the percentage: "today", "this week". */
  deltaSuffix?: string;
  /** Replaces the chip's figure ("New", "+$90.58 this week"). */
  deltaLabel?: ReactNode;
  deltaTitle?: string;
  /** Which way the chip reads as good news: `down` for spending (a rise turns amber). */
  deltaGoodWhen?: "up" | "down";
  /** Another chip after the delta (a Sample label). */
  badge?: ReactNode;
  /** A muted line over the figure ("Spent, last 7 days"). */
  caption?: ReactNode;
  /** On the right: the timeframe chips. */
  right?: ReactNode;
  /** The figure's own title (a tooltip saying what it adds up). */
  valueTitle?: string;
  className?: string;
};

/**
 * Ref E's figure row, under the pair header: "$3,615.86  +3,27% today" on
 * the left and "1h 24h 1w 1m" on the right.
 *
 * ```tsx
 * <FigureRow value={<Money value={1284.5} />} delta={4.5} deltaSuffix="this week" right={<TimeframeChips … />} />
 * ```
 */
export function FigureRow({ value, delta, deltaSuffix, deltaLabel, deltaTitle, deltaGoodWhen, badge, caption, right, valueTitle, className }: FigureRowProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-3 font-satoshi", className)}>
      <div className="min-w-0">
        {caption ? <p className="mb-2 text-[14px] text-ui-muted">{caption}</p> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {value === undefined ? (
            <Skeleton width={240} height={44} />
          ) : (
            <>
              <span className="ui-figure text-[36px] leading-none font-medium tracking-[-0.035em] text-ui-text sm:text-[44px]" title={valueTitle}>
                {value}
              </span>
              {delta !== undefined || deltaLabel ? (
                <DeltaChip
                  value={delta ?? null}
                  suffix={delta === null || delta === undefined ? undefined : deltaSuffix}
                  label={deltaLabel}
                  title={deltaTitle}
                  goodWhen={deltaGoodWhen}
                />
              ) : null}
              {badge}
            </>
          )}
        </div>
      </div>
      {right ? <div className="min-w-0">{right}</div> : null}
    </div>
  );
}
