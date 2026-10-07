import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { pressable } from "../primitives/Button";
import { Money } from "../primitives/Money";

export type TxRowProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "value"> & {
  /** The brand circle or avatar (an <Avatar>). */
  leading: ReactNode;
  title: ReactNode;
  /** Time or date under the title. */
  subtitle?: ReactNode;
  /** Signed dollars: negative is money out. */
  amount?: number;
  /** Or any node in the amount slot. */
  value?: ReactNode;
  /** The line under the amount: the Pay in 4 instalment, "+$5.90". */
  subAmount?: ReactNode;
  /**
   * `plain`: ref A's rows on a card, amounts in the text colour.
   * `card`: ref D's rows, each its own rounded surface, amounts in green or coral.
   */
  variant?: "plain" | "card";
  /** Trailing content after the amount (a chevron, a Badge). */
  trailing?: ReactNode;
  /** Render as a static row instead of a button. */
  static?: boolean;
};

/**
 * A transaction: brand circle, title and time, amount and sub-amount.
 *
 * ```tsx
 * <TxRow leading={<Avatar name="Blue Bottle" color="#1f6feb" />} title="Blue Bottle" subtitle="9:10 AM" amount={-59} subAmount="Pay in 4 · $14.75" />
 * <TxRow variant="card" leading={<Avatar name="Yulia P" />} title="Yulia Polishchuk" subtitle="19 Oct 15:58" amount={2351} />
 * ```
 */
export const TxRow = forwardRef<HTMLButtonElement, TxRowProps>(function TxRow(
  {
    leading,
    title,
    subtitle,
    amount,
    value,
    subAmount,
    variant = "plain",
    trailing,
    static: isStatic = false,
    className,
    type,
    ...props
  },
  ref,
) {
  const card = variant === "card";
  const amountNode =
    value ??
    (amount !== undefined ? (
      <Money
        value={amount}
        signed
        dim="none"
        className={cn(card && (amount >= 0 ? "text-ui-up" : "text-ui-down"))}
      />
    ) : null);

  const body = (
    <>
      <span className="shrink-0">{leading}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[16px] leading-tight font-medium tracking-[-0.01em] text-ui-text">{title}</span>
        {subtitle ? (
          <span className={cn("mt-1 block truncate leading-tight text-ui-muted", card ? "text-[14px]" : "text-[12px]")}>
            {subtitle}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right">
        <span className={cn("block leading-tight font-medium text-ui-text", card ? "text-[15px]" : "text-[16px]")}>{amountNode}</span>
        {subAmount ? <span className="ui-figure mt-1 block text-[11px] leading-tight text-ui-muted">{subAmount}</span> : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </>
  );

  const classes = cn(
    "flex w-full items-center gap-3.5 font-satoshi",
    card ? "min-h-16 rounded-[22px] bg-ui-surface-2 px-5 py-3" : "min-h-[60px] rounded-ui-row py-2",
    className,
  );

  if (isStatic) {
    return <div className={classes}>{body}</div>;
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        classes,
        pressable,
        "active:scale-[0.98]",
        card ? "hover:bg-ui-surface-3" : "-mx-2 w-[calc(100%+16px)] px-2 hover:bg-ui-surface-2",
      )}
      {...props}
    >
      {body}
    </button>
  );
});
