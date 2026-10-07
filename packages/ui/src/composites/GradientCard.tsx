import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";

export type GradientTone = "crimson" | "purple" | "purple-chart" | "lime";

const TONES: Record<GradientTone, string> = {
  // Ref B: "Your portfolio", brighter at the left.
  crimson: "linear-gradient(100deg, #f5335e 0%, #e93158 45%, #de2f53 75%, #d02d52 100%)",
  // Ref A: "My Spending", flat. A shade under ref A's #8e5cf0 so white text
  // on it passes AA (4.77:1).
  purple: "#8452ec",
  // Ref B: the price chart card.
  "purple-chart": "linear-gradient(160deg, #9a3ed4 0%, #923eca 40%, #8a31c6 70%, #7e2ab5 100%)",
  lime: "#9cef5e",
};

export type GradientCardProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  tone?: GradientTone;
  /** The small label at the top ("Your credit line"). */
  label?: ReactNode;
  /** The big figure (usually a <Money>). */
  value?: ReactNode;
  /** Under the figure: a <DeltaBadge> chip or a line. */
  meta?: ReactNode;
  /** Top right: toggles, an IconButton. */
  actions?: ReactNode;
  /** A chart: beside the figure (`side`, ref A) or under it (`stack`, ref B). */
  chart?: ReactNode;
  layout?: "stack" | "side";
  children?: ReactNode;
};

/**
 * The coloured hero cards: ref B's crimson portfolio and purple chart card,
 * ref A's flat purple spending card.
 *
 * ```tsx
 * <GradientCard tone="crimson" label="Your credit line" value={<Money value={500} dim="cents" />} meta={<DeltaBadge variant="chip" value={1.76} amount="$8.80" />} />
 * <GradientCard tone="purple" layout="side" label="My spending" value={…} chart={<LineArea … />} />
 * ```
 */
export function GradientCard({
  tone = "crimson",
  label,
  value,
  meta,
  actions,
  chart,
  layout = "stack",
  className,
  style,
  children,
  ...props
}: GradientCardProps) {
  const dark = tone === "lime";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-ui-card p-6 font-satoshi",
        dark ? "text-[#0f1011]" : "text-white",
        className,
      )}
      style={{ background: TONES[tone], ...style }}
      {...props}
    >
      {layout === "side" && chart ? (
        // Ref A: the chart rides beside the label and figure; the change runs full width under both.
        <div className="grid grid-cols-[minmax(0,1fr)_44%] gap-x-3">
          <div className="min-w-0">
            {label ? <div className={cn("text-[17px] font-medium", tone !== "purple" && "opacity-85")}>{label}</div> : null}
            {value ? <div className="mt-5 text-[34px] leading-none font-bold tracking-[-0.03em]">{value}</div> : null}
          </div>
          <div className="-mr-1 self-center">{chart}</div>
          {meta ? <div className="col-span-2 mt-3">{meta}</div> : null}
        </div>
      ) : (
        <div>
          {label || actions ? (
            <div className="flex items-start justify-between gap-3">
              {label ? <div className={cn("text-[17px] font-medium", tone !== "purple" && "opacity-80")}>{label}</div> : <span />}
              {actions ? <div className="-mt-1 -mr-1 flex shrink-0 items-center gap-2">{actions}</div> : null}
            </div>
          ) : null}
          {value ? <div className="mt-2 text-[42px] leading-none font-bold tracking-[-0.03em]">{value}</div> : null}
          {meta ? <div className="mt-3">{meta}</div> : null}
        </div>
      )}
      {chart && layout === "stack" ? <div className="-mx-6 mt-5">{chart}</div> : null}
      {children}
    </div>
  );
}
