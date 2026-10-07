"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type HTMLAttributes } from "react";

import { cn } from "../lib/cn";
import { formatMoney, moneyParts } from "../lib/format";

export type MoneyProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** Dollars (not cents). */
  value: number;
  currency?: string;
  /**
   * Which parts render dim:
   * `both` (the system default), `symbol` (ref A: "$25,841.11"),
   * `cents` (ref B: "$81,590.90"), `none`.
   */
  dim?: "both" | "symbol" | "cents" | "none";
  /** Opacity of the dim parts, 0.4 to 0.55 in the references. */
  dimOpacity?: number;
  decimals?: number;
  /** Prefix "+" on gains. */
  signed?: boolean;
  /** 37,847 → $37.8K. */
  compact?: boolean;
  /** A space after the symbol: ref D's "$ 24,575". */
  spaced?: boolean;
  /** Tween from the previous value when it changes. */
  animate?: boolean;
};

/**
 * Money with the dim-dollar pattern: the symbol and the cents at about 45%
 * opacity, tabular figures, and an optional tween between values.
 *
 * ```tsx
 * <Money value={25841.11} className="text-[44px] font-semibold" />
 * <Money value={81590.9} dim="cents" />
 * <Money value={24575} decimals={0} spaced dim="none" />
 * <Money value={-15} signed />
 * ```
 */
export function Money({
  value,
  currency = "USD",
  dim = "both",
  dimOpacity = 0.45,
  decimals = 2,
  signed = false,
  compact = false,
  spaced = false,
  animate: shouldAnimate = false,
  className,
  style,
  ...props
}: MoneyProps) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const last = useRef(value);

  useEffect(() => {
    if (!shouldAnimate || reduced) {
      last.current = value;
      setShown(value);
      return;
    }
    const from = last.current;
    last.current = value;
    const controls = animate(from, value, {
      duration: 0.7,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setShown(v),
    });
    return () => controls.stop();
  }, [value, shouldAnimate, reduced]);

  const display = shouldAnimate ? shown : value;
  const p = moneyParts(display, { currency, decimals, signed, compact });
  const dimSymbol = dim === "both" || dim === "symbol";
  const dimCents = dim === "both" || dim === "cents";
  const fade = { opacity: dimOpacity };
  const final = formatMoney(value, { currency, decimals, signed, compact });

  return (
    <span className={cn("ui-figure inline-block whitespace-nowrap", className)} style={style} {...props}>
      <span aria-hidden={shouldAnimate || undefined}>
        {p.sign}
        <span style={dimSymbol ? fade : undefined}>{p.symbol}</span>
        {spaced ? <span aria-hidden className="inline-block w-[0.24em]" /> : null}
        {p.integer}
        {p.fraction ? <span style={dimCents ? fade : undefined}>{p.fraction}</span> : null}
        {p.suffix}
      </span>
      {shouldAnimate ? <span className="sr-only">{final}</span> : null}
    </span>
  );
}
