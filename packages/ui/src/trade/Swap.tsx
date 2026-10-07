"use client";

import { ArrowDownUp } from "lucide-react";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { pressable } from "../primitives/Button";

/* ── SwapCard ───────────────────────────────────────────────────────────── */

export type SwapCardProps = {
  /** The round coin at the top left. */
  coin?: ReactNode;
  /** "ETH", "AUSD". */
  symbol: ReactNode;
  /** The muted note at the top right: "You Buy", "You send". */
  caption?: ReactNode;
  /** The big figure, when it is shown rather than typed. */
  amount?: ReactNode;
  /** Make the figure an input: the typed value and its setter. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** The input's accessible name ("Amount to withdraw"). */
  inputLabel?: string;
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">;
  placeholder?: string;
  /** Turns the figure coral and marks the input invalid. */
  invalid?: boolean;
  /** Bottom right: "Balance" over "293.0187". */
  metaLabel?: ReactNode;
  meta?: ReactNode;
  /** Replaces the figure row (e.g. a set of options). */
  children?: ReactNode;
  className?: string;
};

/**
 * One of the widget's stacked cards ("ETH · You Buy · 12.695 · Balance
 * 293.0187"): #1D2129, 30px corners, the coin and symbol at the top, the
 * big figure at the bottom with its balance on the right. The figure can be
 * an input.
 *
 * ```tsx
 * <SwapCard coin={<PolarisCoin size={42} />} symbol="AUSD" caption="You send" value={amount} onValueChange={setAmount} inputLabel="Amount" metaLabel="Balance" meta="3,196.97" />
 * ```
 */
export const SwapCard = forwardRef<HTMLDivElement, SwapCardProps>(function SwapCard(
  {
    coin,
    symbol,
    caption,
    amount,
    value,
    onValueChange,
    inputLabel,
    inputProps,
    placeholder = "0.00",
    invalid = false,
    metaLabel,
    meta,
    children,
    className,
  },
  ref,
) {
  const id = useId();
  const editable = onValueChange !== undefined;
  const figure = "ui-figure min-w-0 font-satoshi text-[34px] leading-none font-medium tracking-[-0.03em] sm:text-[40px]";
  return (
    <div ref={ref} className={cn("flex min-h-[172px] flex-col rounded-ui-swap bg-ui-surface-1 p-3.5 pb-5 font-satoshi", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          {coin}
          <span className="truncate text-[24px] leading-none font-medium tracking-[-0.01em] text-ui-text sm:text-[26px]">{symbol}</span>
        </div>
        {caption ? <span className="shrink-0 pt-2.5 pr-1.5 text-[15px] text-ui-muted sm:text-[16px]">{caption}</span> : null}
      </div>
      {children ? (
        <div className="mt-auto px-1.5 pt-5">{children}</div>
      ) : (
        <div className="mt-auto flex items-end justify-between gap-4 px-1.5 pt-6">
          {editable ? (
            <input
              id={id}
              aria-label={inputLabel}
              aria-invalid={invalid || undefined}
              inputMode="decimal"
              autoComplete="off"
              placeholder={placeholder}
              value={value ?? ""}
              onChange={(e) => onValueChange(e.target.value)}
              {...inputProps}
              className={cn(
                figure,
                "w-full flex-1 bg-transparent outline-none placeholder:text-ui-dim",
                "rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus",
                invalid ? "text-ui-down" : "text-ui-text",
                inputProps?.className,
              )}
            />
          ) : (
            <span className={cn(figure, "truncate", invalid ? "text-ui-down" : "text-ui-text")}>{amount}</span>
          )}
          {metaLabel || meta ? (
            <span className="shrink-0 pb-0.5 text-right">
              {metaLabel ? <span className="block text-[14px] leading-tight text-ui-muted">{metaLabel}</span> : null}
              {meta ? <span className="ui-figure mt-1 block text-[14px] leading-tight font-semibold text-ui-text">{meta}</span> : null}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
});

/* ── SwapToggle ─────────────────────────────────────────────────────────── */

export type SwapToggleProps = {
  /** The button's name; without `onClick` it is a decorative mark. */
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
};

/**
 * The round button that overlaps the seam between the two cards: near-black,
 * ringed in the panel's colour, with a lime ⇅.
 */
export function SwapToggle({ label, onClick, disabled, icon, className }: SwapToggleProps) {
  const cls = cn(
    "grid size-[46px] place-items-center rounded-full bg-ui-swap text-ui-lime-text ring-[5px] ring-ui-canvas",
    onClick && pressable,
    onClick && "hover:text-ui-lime-active",
    className,
  );
  const inner = <IconSlot size={18}>{icon ?? <ArrowDownUp />}</IconSlot>;
  if (!onClick) {
    return (
      <span aria-hidden className={cls}>
        {inner}
      </span>
    );
  }
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className={cls}>
      {inner}
    </button>
  );
}

/* ── SwapStack ──────────────────────────────────────────────────────────── */

export type SwapStackProps = {
  top: ReactNode;
  bottom: ReactNode;
  /** The toggle on the seam; a decorative one by default. */
  toggle?: ReactNode;
  className?: string;
};

/** The two cards stacked 12px apart with the swap button over the seam. */
export function SwapStack({ top, bottom, toggle, className }: SwapStackProps) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-3", className)}>
      {top}
      <div className="relative">
        <div className="absolute top-0 left-1/2 z-[1] -translate-x-1/2 -translate-y-[calc(50%+6px)]">{toggle ?? <SwapToggle />}</div>
        {bottom}
      </div>
    </div>
  );
}
