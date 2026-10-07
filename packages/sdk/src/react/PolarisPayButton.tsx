"use client";

import React, { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { formatUsd, toCents, type AmountInput } from "../money.js";
import type { PayResult, PayStage } from "../pay/direct.js";
import { usePolarisClient, type PolarisClientProps } from "./context.js";
import type { PolarisButtonSize, PolarisButtonTheme } from "./PolarisCheckoutButton.js";
import { PolarisMark } from "./PolarisMark.js";
import { PolarisStyles } from "./styles.js";

export type PolarisPayButtonProps = PolarisClientProps & {
  /** The merchant's payout address. */
  merchant: string;
  /** USD amount: "25.00". */
  amount: AmountInput;
  /** Your order id, or a function that makes one per attempt. Make it unguessable. */
  orderId: string | (() => string);
  /** Button text. Default "Pay $25.00". */
  label?: ReactNode;
  theme?: PolarisButtonTheme;
  size?: PolarisButtonSize;
  block?: boolean;
  disabled?: boolean;
  onSuccess?: (result: PayResult) => void;
  /** A sentence for the buyer, and the full result for your logs. */
  onError?: (message: string, result: PayResult) => void;
  className?: string;
  style?: CSSProperties;
  id?: string;
};

type Phase = "idle" | PayStage | "done" | "error";

const STAGE_LABEL: Record<PayStage, string> = {
  connecting: "Connecting your wallet…",
  signing: "Confirm in your wallet",
  submitting: "Paying…",
  confirming: "Confirming on Monad…",
};

/**
 * Pay a merchant straight from the buyer's wallet: one signature
 * (ERC-3009), settled by PolarisPayments.payWithAuthorization. Gasless for
 * the buyer when the client has a `relayUrl`.
 */
export function PolarisPayButton(props: PolarisPayButtonProps) {
  const { merchant, amount, orderId, label, theme = "dark", size = "md", block = true, disabled, onSuccess, onError, className, style, id } = props;
  const polaris = usePolarisClient(props);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<PayResult | null>(null);
  const statusId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  let price: string | null = null;
  try {
    price = formatUsd(toCents(amount));
  } catch {
    price = null;
  }

  const busy = phase === "connecting" || phase === "signing" || phase === "submitting" || phase === "confirming";

  const pay = useCallback(async () => {
    setResult(null);
    setPhase("connecting");
    let outcome: PayResult;
    try {
      outcome = await polaris.pay({
        merchant,
        amount,
        orderId: typeof orderId === "function" ? orderId() : orderId,
        onStage: (stage) => {
          if (mounted.current) setPhase(stage);
        },
      });
    } catch (err) {
      // Configuration mistakes throw (an undeployed chain, a bad address); show them as errors too.
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err), cause: err };
    }
    if (!mounted.current) return;
    setResult(outcome);
    setPhase(outcome.ok ? "done" : "error");
    if (outcome.ok) onSuccess?.(outcome);
    else onError?.(outcome.error ?? "The payment didn't go through.", outcome);
  }, [polaris, merchant, amount, orderId, onSuccess, onError]);

  let content: ReactNode;
  if (busy) {
    content = (
      <>
        <span className="plrs-spinner" aria-hidden="true" />
        <span className="plrs-btn__label">{STAGE_LABEL[phase as PayStage]}</span>
      </>
    );
  } else if (phase === "done") {
    content = (
      <>
        <svg className="plrs-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="plrs-btn__label">Paid{price ? ` ${price}` : ""}</span>
      </>
    );
  } else {
    content = (
      <>
        <PolarisMark mono={theme === "lime"} />
        <span className="plrs-btn__label">{label ?? (price ? `Pay ${price}` : "Pay with Polaris")}</span>
      </>
    );
  }

  return (
    <div className={className ? `plrs-root plrs-checkout ${className}` : "plrs-root plrs-checkout"} data-theme={theme} data-block={block} style={style}>
      <PolarisStyles />
      <button
        type="button"
        id={id}
        className="plrs-btn"
        data-size={size}
        data-state={phase === "done" ? "done" : busy ? "busy" : "idle"}
        onClick={busy || phase === "done" ? undefined : pay}
        disabled={disabled || price === null}
        aria-disabled={busy || phase === "done" ? true : undefined}
        aria-busy={busy || undefined}
        aria-describedby={phase === "error" || phase === "done" ? statusId : undefined}
      >
        {content}
      </button>
      {phase === "error" && result?.error ? (
        <p className="plrs-error" id={statusId} role="alert">
          {result.error}
        </p>
      ) : null}
      {phase === "done" && result?.explorerUrl ? (
        <p className="plrs-note" id={statusId}>
          Settled on Monad.{" "}
          <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer">
            View receipt
          </a>
        </p>
      ) : null}
      <span className="plrs-sr" role="status" aria-live="polite">
        {busy ? STAGE_LABEL[phase as PayStage] : phase === "done" ? "Payment complete." : ""}
      </span>
    </div>
  );
}
