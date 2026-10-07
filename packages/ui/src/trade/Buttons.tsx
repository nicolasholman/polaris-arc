import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";
import { Button, pressable, type ButtonProps } from "../primitives/Button";

/*
  Ref E (LumaTrade) buttons. Sizes are the reference's at 1440 wide:
  the nav's "Log in" pill is 44px, the widget's "Buy BTC" and "Connect
  Wallet" are 50px and span the column.
*/

export type TradeButtonSize = "sm" | "md" | "lg";

const HEIGHT: Record<TradeButtonSize, string> = {
  // The nav's lime pill ("Log in").
  sm: "h-11 gap-2 px-5 text-[15px]",
  md: "h-12 gap-2 px-6 text-[15px]",
  // The widget's full-width buttons.
  lg: "h-[50px] gap-2.5 px-7 text-[16px]",
};

export type TradeButtonProps = Omit<ButtonProps, "variant" | "size" | "shape"> & {
  size?: TradeButtonSize;
};

/**
 * The reference's lime button: #B0C956 with a near-black label, fully round.
 * The nav's "Log in" is `size="sm"` with `iconRight`; the widget's "Buy BTC"
 * is `size="lg" block`.
 *
 * ```tsx
 * <PrimaryButton size="sm" iconRight={<Plus />}>New link</PrimaryButton>
 * <PrimaryButton size="lg" block onClick={withdraw}>Withdraw $1,250.00</PrimaryButton>
 * ```
 */
export const PrimaryButton = forwardRef<HTMLButtonElement, TradeButtonProps>(function PrimaryButton(
  { size = "md", className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="lime"
      className={cn(
        HEIGHT[size],
        "bg-ui-lime-button font-semibold tracking-[-0.005em] text-[#121418] hover:brightness-[1.06] [&_svg]:stroke-[2]",
        className,
      )}
      {...props}
    />
  );
});

/**
 * The reference's dark button ("Connect Wallet"): #1D2129, white label, the
 * icon after it.
 *
 * ```tsx
 * <SecondaryButton size="lg" block iconRight={<WalletCards />}>Change payout address</SecondaryButton>
 * ```
 */
export const SecondaryButton = forwardRef<HTMLButtonElement, TradeButtonProps>(function SecondaryButton(
  { size = "md", className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="dark"
      className={cn(HEIGHT[size], "bg-ui-surface-1 font-medium text-ui-text hover:bg-ui-surface-2 hover:brightness-100", className)}
      {...props}
    />
  );
});

export type IconSquareButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** The accessible name (the icon is decorative). */
  label: string;
  icon: ReactNode;
  /** `outline`: the widget's refresh, QR and settings squares. `solid`: the chart toggle's active square. */
  tone?: "outline" | "solid";
  /** Lime icon (the active chart type). */
  active?: boolean;
  size?: "sm" | "md";
};

/**
 * The reference's small square icon buttons: 40px, 12px radius, a hairline
 * outline on a ground darker than the panel (refresh, QR, settings), or the
 * raised #1D2129 square with a lime icon when it is the active one.
 *
 * ```tsx
 * <IconSquareButton label="Refresh" icon={<RefreshCw />} onClick={reload} />
 * ```
 */
export const IconSquareButton = forwardRef<HTMLButtonElement, IconSquareButtonProps>(function IconSquareButton(
  { label, icon, tone = "outline", active = false, size = "md", className, type, ...props },
  ref,
) {
  const px = size === "sm" ? 36 : 40;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={props.title ?? label}
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-[12px] font-satoshi",
        pressable,
        tone === "solid"
          ? "bg-ui-surface-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.02)]"
          : "border border-ui-hairline-strong bg-ui-square hover:bg-ui-surface-1",
        active ? "text-ui-lime-text" : "text-[#a7a9ad] hover:text-ui-text",
        className,
      )}
      style={{ width: px, height: px }}
      {...props}
    >
      <IconSlot size={size === "sm" ? 17 : 19}>{icon}</IconSlot>
    </button>
  );
});
