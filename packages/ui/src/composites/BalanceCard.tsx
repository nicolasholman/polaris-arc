import { Grip } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { IconButton, pressable } from "../primitives/Button";
import { Money } from "../primitives/Money";
import { Pill } from "../primitives/Pill";

export type Action = { label: string; icon: ReactNode; onClick?: () => void; href?: string };

/* ── ActionRow ───────────────────────────────────────────────────────────── */

export type ActionRowProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** Up to four round actions: Add, Receive, Send. */
  actions: Action[];
  /** The wide pill at the end (ref A's dots grid). */
  more?: { label: string; onClick?: () => void; icon?: ReactNode };
  /** Show the label under each circle (ref A hides them). */
  showLabels?: boolean;
};

/**
 * Ref A's round white actions, each with a black disc and a white glyph,
 * and the wide "more" pill.
 *
 * ```tsx
 * <ActionRow actions={[{ label: "Add money", icon: <Plus /> }, { label: "Receive", icon: <ArrowDown /> }]} more={{ label: "More" }} />
 * ```
 */
export function ActionRow({ actions, more, showLabels = false, className, ...props }: ActionRowProps) {
  const circle = (a: Action) => {
    const inner = (
      <>
        <span className="grid size-[30px] place-items-center rounded-full bg-[#0f1011] text-white">
          <IconSlot size={18}>{a.icon}</IconSlot>
        </span>
        {showLabels ? null : <span className="sr-only">{a.label}</span>}
      </>
    );
    const cls = cn("grid size-16 shrink-0 place-items-center rounded-full bg-white", pressable);
    return a.href ? (
      <a href={a.href} className={cls} title={a.label}>
        {inner}
      </a>
    ) : (
      <button type="button" onClick={a.onClick} className={cls} title={a.label}>
        {inner}
      </button>
    );
  };
  return (
    <div className={cn("flex items-start gap-1.5 font-satoshi", className)} {...props}>
      {actions.map((a) => (
        <div key={a.label} className="flex flex-col items-center gap-1.5">
          {circle(a)}
          {showLabels ? <span className="text-[12px] font-medium text-[#0f1011]/80">{a.label}</span> : null}
        </div>
      ))}
      {more ? (
        <button
          type="button"
          onClick={more.onClick}
          title={more.label}
          className={cn("grid h-16 min-w-16 flex-1 place-items-center rounded-full bg-white text-[#0f1011]", pressable)}
        >
          <IconSlot size={24}>{more.icon ?? <Grip strokeWidth={2.5} />}</IconSlot>
          <span className="sr-only">{more.label}</span>
        </button>
      ) : null}
    </div>
  );
}

/* ── BalanceCard ─────────────────────────────────────────────────────────── */

export type BalanceCardProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** The account pill ("Main account ▾"). */
  account?: string;
  onAccountClick?: () => void;
  /** Small labels over the figure ("USD", "AUSD"). */
  labels?: string[];
  /** Dollars. */
  balance: number;
  /** Percent change beside the figure, or a word ("New"). */
  delta?: number | string;
  /** The period the change is over ("this week"), after it. */
  deltaNote?: string;
  /** The black round buttons, top right (bolt, pencil). */
  quickActions?: Action[];
  /** The white action row at the bottom. */
  actions?: Action[];
  more?: ActionRowProps["more"];
};

/**
 * Ref A's lime balance card.
 *
 * ```tsx
 * <BalanceCard account="Main account" labels={["USD", "AUSD"]} balance={1284.5} delta={2.1}
 *   quickActions={[{ label: "Boost", icon: <Zap /> }]} actions={[{ label: "Add", icon: <Plus /> }]} more={{ label: "More" }} />
 * ```
 */
export function BalanceCard({
  account = "Main account",
  onAccountClick,
  labels = ["USD", "AUSD"],
  balance,
  delta,
  deltaNote,
  quickActions = [],
  actions = [],
  more,
  className,
  ...props
}: BalanceCardProps) {
  return (
    <div className={cn("rounded-ui-card bg-ui-lime p-5 font-satoshi text-[#0f1011]", className)} {...props}>
      <div className="flex items-center justify-between gap-3">
        {onAccountClick ? (
          <Pill tone="black" size="lg" chevron onClick={onAccountClick} className="h-10 pr-3 pl-4">
            {account}
          </Pill>
        ) : (
          <Pill tone="black" size="lg" className="h-10 px-4">
            {account}
          </Pill>
        )}
        {quickActions.length ? (
          <div className="flex items-center gap-2">
            {quickActions.map((a) => (
              <IconButton key={a.label} label={a.label} icon={a.icon} tone="black" size="md" className="size-10" onClick={a.onClick} />
            ))}
          </div>
        ) : null}
      </div>
      <div className="mt-8 flex gap-5 text-[13px] font-medium tracking-[0.01em] text-[#0f1011]/85">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <div className="mt-1.5 flex items-end gap-2.5">
        <Money value={balance} dim="symbol" dimOpacity={0.38} className="text-[48px] leading-none font-semibold tracking-[-0.04em]" />
        {delta !== undefined ? (
          <span className="ui-figure mb-1.5 text-[12px] font-medium">
            {typeof delta === "string" ? (
              delta
            ) : (
              <>
                {delta >= 0 ? "+" : "-"}
                {Math.abs(delta).toFixed(2)}%
              </>
            )}
            {deltaNote ? <span className="opacity-70"> {deltaNote}</span> : null}
          </span>
        ) : null}
      </div>
      {actions.length || more ? <ActionRow actions={actions} more={more} className="mt-6" /> : null}
    </div>
  );
}
