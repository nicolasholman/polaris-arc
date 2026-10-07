"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

import { CREDIT_PAUSED_MESSAGE } from "../credit.js";
import { formatUsdAmount, quotePayIn4, toCents, type AmountInput, type PayIn4Quote } from "../money.js";
import { PolarisMark } from "./PolarisMark.js";
import { PolarisStyles } from "./styles.js";

export type PolarisMessagingProps = {
  /** The product or cart price: "201.50". */
  amount: AmountInput;
  /** Buyer APR in basis points. Default 1000 (10%): PolarisLoanEngine.INTEREST_RATE_BPS, what every Polaris plan charges. */
  aprBps?: number;
  /** Seconds between instalments. Default one week. */
  intervalSeconds?: number;
  /** Hide the badge outside this range. Defaults: $1.00 to $5,000.00 (the top credit tier). */
  minAmount?: AmountInput;
  maxAmount?: AmountInput;
  /** Popover colours: "light" (default) or "dark". The sentence itself inherits your text colour. */
  theme?: "light" | "dark";
  /** Which edge the popover lines up with. Default "start". */
  align?: "start" | "end";
  className?: string;
  style?: CSSProperties;
  /**
   * The credit guard has paused new Pay in 4 plans (`polaris.credit.guard()`
   * on your server): pass `true` or its `message`. The line then says Pay
   * in 4 is paused and that paying now works, instead of offering a plan.
   */
  paused?: boolean | string | null;
};

const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;

/**
 * When an instalment falls due, from checkout: "in 1 week", "tomorrow",
 * "in 3 days", "in 2 hours", "in 5 min". Never "today": PolarisLoanEngine
 * collects nothing at checkout, and the first instalment is one interval out.
 */
function describeDue(dueInSeconds: number): string {
  if (dueInSeconds % WEEK === 0) {
    const n = dueInSeconds / WEEK;
    return n === 1 ? "in 1 week" : `in ${n} weeks`;
  }
  if (dueInSeconds % DAY === 0) {
    const n = dueInSeconds / DAY;
    return n === 1 ? "tomorrow" : `in ${n} days`;
  }
  if (dueInSeconds % HOUR === 0) {
    const n = dueInSeconds / HOUR;
    return n === 1 ? "in 1 hour" : `in ${n} hours`;
  }
  const minutes = Math.max(1, Math.round(dueInSeconds / 60));
  return minutes === 1 ? "in 1 min" : `in ${minutes} min`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cadence(seconds: number): string {
  if (seconds % WEEK === 0) return seconds === WEEK ? "every week" : `every ${seconds / WEEK} weeks`;
  if (seconds % DAY === 0) return seconds === DAY ? "every day" : `every ${seconds / DAY} days`;
  if (seconds % HOUR === 0) return seconds === HOUR ? "every hour" : `every ${seconds / HOUR} hours`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

function inRange(amount: AmountInput, min: AmountInput, max: AmountInput): boolean {
  try {
    const cents = toCents(amount);
    return cents >= toCents(min) && cents <= toCents(max);
  } catch {
    return false;
  }
}

/** "$50.38" with the dollar sign dimmed, the design system's money style. */
function Money({ value }: { value: string }) {
  const text = formatUsdAmount(value);
  return (
    <>
      <span className="plrs-hero__dim">{text.slice(0, 1)}</span>
      {text.slice(1)}
    </>
  );
}

/**
 * The product-page line: "or 4 payments of $50.38 with ✦ Polaris · Learn more".
 * "Learn more" opens a popover with the schedule, the interest, and how it works.
 * Renders nothing when the amount is outside the range Pay in 4 serves.
 */
export function PolarisMessaging({
  amount,
  aprBps,
  intervalSeconds,
  minAmount = "1.00",
  maxAmount = "5000.00",
  theme = "light",
  align = "start",
  className,
  style,
  paused,
}: PolarisMessagingProps) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const quote: PayIn4Quote | null = useMemo(() => {
    if (!inRange(amount, minAmount, maxAmount)) return null;
    try {
      return quotePayIn4(amount, { aprBps, intervalSeconds });
    } catch {
      return null;
    }
  }, [amount, aprBps, intervalSeconds, minAmount, maxAmount]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  if (!quote) return null;

  if (paused) {
    return (
      <div className={className ? `plrs-root plrs-msg ${className}` : "plrs-root plrs-msg"} data-theme={theme} data-paused="" style={style}>
        <PolarisStyles />
        <span role="status">
          <span className="plrs-brand">
            <PolarisMark />
            Polaris
          </span>{" "}
          {typeof paused === "string" ? paused : CREDIT_PAUSED_MESSAGE}
        </span>
      </div>
    );
  }

  const count = quote.installments.length;
  const each = formatUsdAmount(quote.each);
  const first = quote.installments[0]!;

  return (
    <div ref={rootRef} className={className ? `plrs-root plrs-msg ${className}` : "plrs-root plrs-msg"} data-theme={theme} style={style}>
      <PolarisStyles />
      <span>
        or {count} payments of <strong>{each}</strong> with{" "}
        <span className="plrs-brand">
          <PolarisMark />
          Polaris
        </span>
        <button
          ref={triggerRef}
          type="button"
          className="plrs-link"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          onClick={() => (open ? close(true) : setOpen(true))}
        >
          Learn more<span className="plrs-sr"> about paying in {count} with Polaris</span>
        </button>
      </span>

      {open ? (
        <div
          ref={popoverRef}
          id={popoverId}
          className="plrs-pop"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-align={align}
        >
          <div className="plrs-pop__head">
            <PolarisMark />
            <h2 className="plrs-pop__title" id={titleId}>
              Pay in {count} with Polaris
            </h2>
            <button type="button" className="plrs-close" aria-label="Close" onClick={() => close(true)}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <p className="plrs-hero">
            {count} × <Money value={quote.each} />
          </p>
          <p className="plrs-sub">
            {`${formatUsdAmount(quote.total)} in total, including ${formatUsdAmount(quote.interest)} interest (${quote.aprBps / 100}% APR).`}
          </p>

          <ol className="plrs-sched" style={{ ["--plrs-n" as string]: String(Math.min(count, 6)) }} aria-label="Payment schedule">
            {quote.installments.slice(0, 6).map((row) => (
              <li key={row.index}>
                <span className="plrs-tick" aria-hidden="true" />
                <span className="plrs-when">{capitalise(describeDue(row.dueInSeconds))}</span>
                <span className="plrs-amt">{formatUsdAmount(row.amount)}</span>
              </li>
            ))}
          </ol>

          <ol className="plrs-steps">
            <li>Choose Polaris at checkout, then Pay in {count}.</li>
            <li>Continue with Face ID. No app to install, no password, no seed phrase.</li>
            <li>
              {count === 1
                ? `Nothing to pay today. Your payment of ${formatUsdAmount(first.amount)} is ${describeDue(first.dueInSeconds)}, collected automatically.`
                : `Nothing to pay today. Your first payment of ${formatUsdAmount(first.amount)} is ${describeDue(first.dueInSeconds)}, and the rest follow ${cadence(quote.intervalSeconds)}, automatically.`}
            </li>
          </ol>

          <p className="plrs-fine">
            Pay in {count} runs on your Polaris credit line, scored on chain with the reasons shown to you. Opening lines run from $200 to
            $1,000 and grow as you repay on time. The merchant is paid in full today, in dollars (AUSD) on Monad.
          </p>
        </div>
      ) : null}
    </div>
  );
}
