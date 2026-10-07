"use client";

import { Coin, DeltaChip, DollarCoin, PairHeader, PolarisCoin, Skeleton, cn, type CoinTone } from "@polaris/ui";
import type { ReactNode } from "react";


/** A page's coin: a flat colour with a white glyph, like the reference's ETH coin. */
export function PageCoin({ tone, children, size = 50 }: { tone: CoinTone; children: ReactNode; size?: number }) {
  return (
    <Coin tone={tone} size={size}>
      <span className="inline-grid place-items-center [&_svg]:size-full [&_svg]:stroke-[2.25]" style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }}>
        {children}
      </span>
    </Coin>
  );
}

/**
 * Every dashboard page opens like ref E's chart: overlapping coins, the
 * page's name at the pair's size, and square icon actions on the right.
 *
 * ```tsx
 * <PageHead title="Payments" actions={<IconSquareButton label="Export" icon={<Download />} />} />
 * ```
 */
export function PageHead({
  title,
  coins,
  actions,
  description,
  className,
}: {
  title: string;
  /** The pair on the left; the Polaris and dollar coins by default. */
  coins?: ReactNode[];
  actions?: ReactNode;
  /** A muted line under the head. */
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6", className)}>
      <PairHeader
        as="h1"
        coins={coins ?? [<PolarisCoin key="p" size={50} />, <DollarCoin key="d" size={50} />]}
        title={title}
        trailing={actions ? <div className="flex items-center gap-2">{actions}</div> : undefined}
      />
      {description ? <p className="mt-3 max-w-[640px] text-[15px] leading-relaxed text-ui-muted">{description}</p> : null}
    </div>
  );
}

/**
 * Ref E's figure row: the big number with its delta chip, and on the right
 * the page's chips (a timeframe, a filter).
 */
export function FigureRow({
  value,
  delta,
  deltaSuffix,
  deltaLabel,
  deltaTitle,
  caption,
  right,
  className,
}: {
  /** The big figure; undefined while it loads. */
  value: ReactNode | undefined;
  delta?: number | null;
  deltaSuffix?: string;
  /** Replaces the chip's figure ("New"). */
  deltaLabel?: ReactNode;
  deltaTitle?: string;
  /** A muted line over the figure ("Gross, last 30 days"). */
  caption?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-3", className)}>
      <div className="min-w-0">
        {caption ? <p className="mb-2 text-[14px] text-ui-muted">{caption}</p> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {value === undefined ? (
            <Skeleton width={240} height={44} />
          ) : (
            <>
              <span className="ui-figure text-[36px] leading-none font-medium tracking-[-0.035em] sm:text-[44px]">{value}</span>
              {delta !== undefined || deltaLabel ? (
                <DeltaChip value={delta ?? null} suffix={delta === null || delta === undefined ? undefined : deltaSuffix} label={deltaLabel} title={deltaTitle} />
              ) : null}
            </>
          )}
        </div>
      </div>
      {right ? <div className="min-w-0">{right}</div> : null}
    </div>
  );
}
