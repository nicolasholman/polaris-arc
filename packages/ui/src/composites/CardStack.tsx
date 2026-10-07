import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { pressable } from "../primitives/Button";
import { Money } from "../primitives/Money";
import { DeltaBadge } from "../primitives/Pill";

export type CardStackAction = {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  /** `outline` (ref D's "+"), `mint`, `honey`, `lime`, `sky`. */
  tone?: "outline" | "mint" | "honey" | "lime" | "sky";
  /** Can't be used yet: say why beside the card, and in `title`. */
  disabled?: boolean;
  /** The tooltip; defaults to the label. */
  title?: string;
};

const ACTION_TONES = {
  outline: "border border-ui-hairline-strong bg-transparent text-ui-text hover:bg-ui-surface-2",
  mint: "bg-ui-mint-soft text-[#1d2a24] hover:brightness-[1.03]",
  honey: "bg-ui-honey text-[#2f2410] hover:brightness-[1.03]",
  lime: "bg-ui-lime text-ui-on-lime hover:brightness-[1.03]",
  sky: "bg-ui-sky text-[#16202c] hover:brightness-[1.03]",
};

export type CardStackProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** The name on the card face. */
  name: string;
  /** Last four of the account or payout wallet. */
  last4: string;
  /** Right of the number: an expiry, "AUSD", a network. */
  meta?: ReactNode;
  balanceLabel?: string;
  /** Dollars. */
  balance: number;
  /** The balance's decimals: ref D's whole dollars ("$ 24,575") by default; 2 to match the cents shown elsewhere. */
  decimals?: number;
  /** Ref D's space after the "$"; off beside figures written "$1,284.50". */
  spaced?: boolean;
  deltaLabel?: string;
  /** Percent change, or a word ("New", "No change") shown as it is. */
  /** Percent. */
  delta?: number | string;
  /** The side squares, top to bottom (up to three). */
  actions?: CardStackAction[];
  /** A small mark on the card face, top right. */
  badge?: ReactNode;
};

/**
 * Ref D's balance card: a pale-sky card face over a dark balance panel, with
 * square actions stacked beside it.
 *
 * ```tsx
 * <CardStack name="Acme Coffee" last4="2431" meta="AUSD" balance={62745} delta={11.05}
 *   actions={[{ label: "New payout", icon: <Plus />, tone: "outline" }, { label: "Withdraw", icon: <ArrowUpFromLine />, tone: "mint" }]} />
 * ```
 */
export function CardStack({
  name,
  last4,
  meta,
  balanceLabel = "Balance",
  balance,
  decimals = 0,
  spaced = decimals === 0,
  deltaLabel = "This week",
  delta,
  actions = [],
  badge,
  className,
  ...props
}: CardStackProps) {
  return (
    <div className={cn("flex gap-3 font-satoshi", className)} {...props}>
      <div className="@container min-w-0 flex-1 overflow-hidden rounded-ui-card bg-ui-surface-3">
        <div
          className="relative px-6 pt-5 pb-5 text-[#13141f]"
          style={{ background: "linear-gradient(135deg, #b9d3fb 0%, #c8e4fb 45%, #c5dbf2 100%)" }}
        >
          <div className="flex items-start justify-between gap-3">
            <span className="truncate text-[22px] leading-tight font-medium tracking-[-0.02em]">{name}</span>
            {badge ?? (
              <span aria-hidden className="flex h-7 shrink-0 items-center rounded-full bg-white px-2">
                <span className="size-3.5 rounded-full bg-[#13141f]" />
                <span className="-ml-1.5 size-3.5 rounded-full bg-[#13141f]/55" />
              </span>
            )}
          </div>
          <div className="ui-figure mt-3 flex items-center justify-between text-[15px] font-medium">
            <span>
              <span aria-hidden className="mr-2 tracking-[0.1em]">
                ****
              </span>
              <span className="sr-only">ending in </span>
              {last4}
            </span>
            {meta ? <span>{meta}</span> : null}
          </div>
        </div>
        <div className="px-6 pt-5 pb-6 text-ui-text">
          <div className="text-[15px]">{balanceLabel}</div>
          <Money
            value={balance}
            decimals={decimals}
            spaced={spaced}
            dim={decimals > 0 ? "cents" : "none"}
            // Shrinks with the card so the figure never clips beside the squares.
            className={cn(
              "mt-1.5 leading-none font-bold tracking-[-0.03em]",
              decimals > 0 ? "text-[30px] @[250px]:text-[38px]" : "text-[34px] @[250px]:text-[44px]",
            )}
          />
          {delta !== undefined ? (
            <div className="mt-3 flex items-center justify-between gap-3 text-[14px]">
              <span className="text-ui-text/65">{deltaLabel}</span>
              {typeof delta === "string" ? <span className="text-[14px] font-medium">{delta}</span> : <DeltaBadge value={delta} size="sm" className="text-[14px]" />}
            </div>
          ) : null}
        </div>
      </div>
      {actions.length ? (
        <div className="flex w-[84px] shrink-0 flex-col gap-3">
          {actions.slice(0, 3).map((a) => (
            <button
              key={a.label}
              type="button"
              aria-label={a.label}
              title={a.title ?? a.label}
              onClick={a.onClick}
              disabled={a.disabled}
              className={cn(
                "grid flex-1 place-items-center rounded-[22px] min-h-[76px]",
                pressable,
                ACTION_TONES[a.tone ?? "outline"],
              )}
            >
              <IconSlot size={24}>{a.icon}</IconSlot>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
