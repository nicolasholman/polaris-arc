"use client";

import { Delete } from "lucide-react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect, useRef, type HTMLAttributes } from "react";

import { cn } from "../lib/cn";
import { currencySymbol, groupTyped } from "../lib/format";

export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "backspace";

const KEYS: KeypadKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "backspace"];

export type KeypadProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  onKey: (key: KeypadKey) => void;
  /** Hold backspace to clear everything. */
  onClear?: () => void;
  /** Hide the decimal point (whole amounts). */
  noDecimal?: boolean;
  /** Also answer the physical keyboard (digits, ".", Backspace). */
  captureKeyboard?: boolean;
  disabled?: boolean;
};

/**
 * Ref A's number pad: 22px-radius keys on surface-2 and a purple backspace.
 *
 * ```tsx
 * <Keypad onKey={(k) => setAmount((a) => applyKey(a, k))} captureKeyboard />
 * ```
 */
export function Keypad({ onKey, onClear, noDecimal = false, captureKeyboard = false, disabled = false, className, ...props }: KeypadProps) {
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!captureKeyboard || disabled) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (/^[0-9]$/.test(e.key)) onKey(e.key as KeypadKey);
      else if ((e.key === "." || e.key === ",") && !noDecimal) onKey(".");
      else if (e.key === "Backspace") onKey("backspace");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onDown);
    return () => window.removeEventListener("keydown", onDown);
  }, [captureKeyboard, disabled, noDecimal, onKey]);

  return (
    <div role="group" aria-label="Keypad" className={cn("grid grid-cols-3 gap-2.5 font-satoshi", className)} {...props}>
      {KEYS.map((k) => {
        if (k === "." && noDecimal) return <span key={k} aria-hidden />;
        const back = k === "backspace";
        return (
          <button
            key={k}
            type="button"
            disabled={disabled}
            aria-label={back ? "Delete" : k === "." ? "Decimal point" : k}
            onClick={() => onKey(k)}
            onPointerDown={() => {
              if (!back || !onClear) return;
              hold.current = setTimeout(() => {
                onClear();
                hold.current = null;
              }, 550);
            }}
            onPointerUp={() => hold.current && clearTimeout(hold.current)}
            onPointerLeave={() => hold.current && clearTimeout(hold.current)}
            className={cn(
              "grid h-16 place-items-center rounded-ui-key text-[28px] leading-none font-normal select-none",
              "transition-[transform,background-color] duration-150 ease-ui-spring active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus disabled:opacity-40",
              back ? "bg-ui-purple text-white active:brightness-110" : "bg-ui-surface-2 text-ui-text active:bg-ui-surface-3",
            )}
          >
            {back ? <Delete aria-hidden size={26} strokeWidth={1.75} /> : k === "." ? <span className="-mt-2">.</span> : k}
          </button>
        );
      })}
    </div>
  );
}

/** Apply a key to a typed amount string, keeping two decimals and a sane length. */
export function applyKey(current: string, key: KeypadKey, { maxDecimals = 2, maxDigits = 7 } = {}): string {
  if (key === "backspace") return current.slice(0, -1);
  if (key === ".") {
    if (current.includes(".") || maxDecimals === 0) return current;
    return current === "" ? "0." : `${current}.`;
  }
  const [int = "", frac] = current.split(".");
  if (frac !== undefined) return frac.length >= maxDecimals ? current : current + key;
  if (int === "0") return key;
  if (int.length >= maxDigits) return current;
  return current + key;
}

export type AmountDisplayProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** What was typed: "1500", "12.5". Empty shows the placeholder. */
  value: string;
  currency?: string;
  /** Shakes once when this changes to true (over a limit, say). */
  invalid?: boolean;
  /** A line under the amount ("Available $1,284.50"). */
  hint?: React.ReactNode;
  /** A blinking lime caret after the figure (off in ref A). */
  caret?: boolean;
  size?: "md" | "lg";
};

/**
 * The big typed amount with the dim dollar (ref A's "$1,500"). It shrinks
 * as the number grows and shakes when it is invalid.
 *
 * ```tsx
 * <AmountDisplay value={amount} hint="Available $1,284.50" invalid={tooMuch} />
 * ```
 */
export function AmountDisplay({
  value,
  currency = "USD",
  invalid = false,
  hint,
  caret = false,
  size = "lg",
  className,
  ...props
}: AmountDisplayProps) {
  const controls = useAnimationControls();
  const reduced = useReducedMotion();
  useEffect(() => {
    if (invalid && !reduced) void controls.start({ x: [0, -10, 9, -6, 4, 0], transition: { duration: 0.42 } });
  }, [invalid, reduced, controls]);

  const shown = value === "" ? "0" : groupTyped(value);
  const len = shown.replace(/,/g, "").length;
  const base = size === "lg" ? 64 : 48;
  const fontSize = len > 9 ? base * 0.62 : len > 7 ? base * 0.74 : len > 5 ? base * 0.86 : base;

  return (
    <div className={cn("flex flex-col items-center font-satoshi", className)} {...props}>
      <motion.output
        animate={controls}
        aria-live="polite"
        aria-label={`${currencySymbol(currency)}${shown}`}
        className={cn(
          "ui-figure flex items-baseline leading-none font-semibold tracking-[-0.035em] transition-[font-size] duration-200",
          invalid ? "text-ui-down" : value === "" ? "text-ui-dim" : "text-ui-text",
        )}
        style={{ fontSize }}
      >
        <span aria-hidden className="opacity-45">
          {currencySymbol(currency)}
        </span>
        <span aria-hidden>{shown}</span>
        {caret ? (
          <span aria-hidden className="ml-1 inline-block w-[3px] self-stretch rounded-full bg-ui-lime animate-ui-caret motion-reduce:animate-none" />
        ) : null}
      </motion.output>
      {hint ? <div className="mt-3 text-[14px] text-ui-muted">{hint}</div> : null}
    </div>
  );
}
