"use client";

import React, { useId, useMemo, type CSSProperties, type ReactNode } from "react";

import type { CheckoutSource, OpenCheckoutOptions } from "../checkout/browser.js";
import type { CheckoutCompleted, CheckoutResult, CheckoutSession, CheckoutTarget } from "../checkout/types.js";
import type { PolarisError } from "../errors.js";
import { formatUsdAmount, quotePayIn4, type AmountInput, type PayIn4Quote } from "../money.js";
import type { CheckoutMode } from "../types.js";
import type { PolarisClientProps } from "./context.js";
import { PolarisMark } from "./PolarisMark.js";
import { PolarisStyles } from "./styles.js";
import { usePolarisCheckout, type CheckoutStatus } from "./usePolarisCheckout.js";

export type PolarisButtonTheme = "dark" | "lime" | "light";
export type PolarisButtonSize = "sm" | "md" | "lg";

/** A session as your server returned it: at least its id or URL; amount and modes let the button show the Pay in 4 line. */
export type CheckoutSessionLike = CheckoutTarget | (Partial<CheckoutSession> & { id: string });

export type PolarisCheckoutButtonProps = PolarisClientProps &
  Pick<OpenCheckoutOptions, "display" | "timeoutMs" | "overlay" | "onBlocked"> & {
    /** A session your server already created (or its id or URL). */
    session?: CheckoutSessionLike;
    /** Create the session on click, e.g. `() => fetch("/api/checkout", { method: "POST" }).then(r => r.json())`. */
    createSession?: () => Promise<CheckoutSessionLike>;
    /** The order total, for the "or 4 × $X" line. Defaults to the session's amount. */
    amount?: AmountInput;
    /** Show the Pay in 4 line. Default: when the amount is known and the session offers "later". */
    installments?: boolean;
    /** Buyer APR for the Pay in 4 line, in basis points. Default 1000 (10%): PolarisLoanEngine.INTEREST_RATE_BPS, what every Polaris plan charges. */
    aprBps?: number;
    /** Button text after the mark. Default "Pay with Polaris". */
    label?: ReactNode;
    /** "dark" (default): ink button, lime star. "lime": the Polaris CTA. "light": white with a hairline. */
    theme?: PolarisButtonTheme;
    size?: PolarisButtonSize;
    /** Fill the container's width. Default true. */
    block?: boolean;
    disabled?: boolean;
    onResult?: (result: CheckoutResult) => void;
    /** The checkout reported a completed payment. Show a thank-you; fulfil from the webhook. */
    onSuccess?: (result: CheckoutCompleted) => void;
    /** The buyer canceled or closed the checkout. */
    onCancel?: (result: CheckoutResult) => void;
    onError?: (error: PolarisError) => void;
    className?: string;
    style?: CSSProperties;
    id?: string;
  };

function sessionAmount(session: CheckoutSessionLike | undefined): string | undefined {
  return session && typeof session === "object" && "amount" in session && typeof session.amount === "string" ? session.amount : undefined;
}

function sessionModes(session: CheckoutSessionLike | undefined): CheckoutMode[] | undefined {
  return session && typeof session === "object" && "modes" in session && Array.isArray(session.modes) ? session.modes : undefined;
}

function safeQuote(amount: AmountInput | undefined, aprBps: number | undefined): PayIn4Quote | null {
  if (amount === undefined || amount === "") return null;
  try {
    return quotePayIn4(amount, aprBps === undefined ? {} : { aprBps });
  } catch {
    return null;
  }
}

const NOTES: Partial<Record<CheckoutStatus, string>> = {
  expired: "That checkout expired. Try again.",
  timeout: "The checkout timed out. Try again.",
};

/**
 * "Pay with Polaris": opens the hosted checkout (Pay now, Pay in 4 on Polaris
 * credit, or Subscribe) in a popup on desktop and a full page on phones.
 */
export function PolarisCheckoutButton(props: PolarisCheckoutButtonProps) {
  const {
    session,
    createSession,
    amount,
    installments,
    aprBps,
    label,
    theme = "dark",
    size = "md",
    block = true,
    disabled,
    onResult,
    onSuccess,
    onCancel,
    onError,
    className,
    style,
    id,
    display,
    timeoutMs,
    overlay,
    onBlocked,
    polaris,
    publishableKey,
    checkoutOrigin,
    chain,
    relayUrl,
    provider,
  } = props;

  const captionId = useId();
  const statusId = useId();
  const checkout = usePolarisCheckout({
    polaris,
    publishableKey,
    checkoutOrigin,
    chain,
    relayUrl,
    provider,
    display,
    timeoutMs,
    overlay,
    onBlocked,
    onResult: (result) => {
      onResult?.(result);
      if (result.status === "completed") onSuccess?.(result);
      else if (result.status === "canceled" || result.status === "closed") onCancel?.(result);
    },
    onError,
  });

  const total = amount ?? sessionAmount(session);
  const modes = sessionModes(session);
  const offersLater = !modes || modes.includes("later");
  const quote = useMemo(() => safeQuote(total, aprBps), [total, aprBps]);
  const showLine = (installments ?? offersLater) && quote !== null;

  const source: CheckoutSource | undefined = session ?? createSession;
  const { status } = checkout;
  const busy = status === "creating" || status === "open" || status === "redirecting";
  const done = status === "completed";
  const inert = disabled || !source;

  function onClick() {
    if (inert || busy || done || !source) return;
    void checkout.open(source);
  }

  let content: ReactNode;
  if (status === "creating" || status === "redirecting") {
    content = (
      <>
        <span className="plrs-spinner" aria-hidden="true" />
        <span className="plrs-btn__label">Opening Polaris…</span>
      </>
    );
  } else if (status === "open") {
    content = (
      <>
        <span className="plrs-spinner" aria-hidden="true" />
        <span className="plrs-btn__label">Finish in the Polaris window</span>
      </>
    );
  } else if (done) {
    content = (
      <>
        <svg className="plrs-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="plrs-btn__label">Paid with Polaris</span>
      </>
    );
  } else {
    content = (
      <>
        <PolarisMark mono={theme === "lime"} />
        <span className="plrs-btn__label">
          {label ?? (
            <>
              Pay with <span className="plrs-btn__word">Polaris</span>
            </>
          )}
        </span>
      </>
    );
  }

  const announcement =
    status === "creating" || status === "redirecting"
      ? "Opening Polaris checkout."
      : status === "open"
        ? "Polaris checkout is open in a new window."
        : done
          ? "Payment complete."
          : status === "canceled" || status === "closed"
            ? "Checkout closed."
            : "";

  const errorText =
    status === "error"
      ? checkout.error?.code === "popup_blocked"
        ? "Your browser blocked the Polaris window. Allow pop-ups for this site and try again."
        : "Polaris couldn't open. Try again in a moment."
      : null;

  const describedBy = [showLine ? captionId : null, errorText || NOTES[status] ? statusId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={className ? `plrs-root plrs-checkout ${className}` : "plrs-root plrs-checkout"} data-theme={theme} data-block={block} style={style}>
      <PolarisStyles />
      <button
        type="button"
        id={id}
        className="plrs-btn"
        data-size={size}
        data-state={done ? "done" : busy ? "busy" : "idle"}
        onClick={onClick}
        disabled={inert}
        aria-disabled={busy || done ? true : undefined}
        aria-busy={busy || undefined}
        aria-describedby={describedBy}
      >
        {content}
      </button>
      {showLine && quote ? (
        <p className="plrs-caption" id={captionId}>
          <span className="plrs-dim">or {quote.installments.length} × </span>
          <strong>{formatUsdAmount(quote.each)}</strong>
          <span className="plrs-dim"> with Pay in 4</span>
        </p>
      ) : null}
      {errorText ? (
        <p className="plrs-error" id={statusId} role="alert">
          {errorText}
        </p>
      ) : NOTES[status] ? (
        <p className="plrs-note" id={statusId}>
          {NOTES[status]}
        </p>
      ) : null}
      <span className="plrs-sr" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
