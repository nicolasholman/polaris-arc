"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CheckoutSource, OpenCheckoutOptions } from "../checkout/browser.js";
import type { CheckoutResult, CheckoutTarget } from "../checkout/types.js";
import type { Polaris, PolarisOptions } from "../client.js";
import { PolarisError, isPolarisError } from "../errors.js";
import { usePolarisClient, type PolarisClientProps } from "./context.js";

/**
 * The hosted checkout as React state.
 *
 *   const checkout = usePolarisCheckout({ publishableKey });
 *   <button onClick={() => checkout.open(() => fetch("/api/checkout", { method: "POST" }).then(r => r.json()))}>
 *   {checkout.status === "completed" && <p>Thanks!</p>}
 *
 * `open` can take a session, its id or URL, or a function that creates one on
 * your server: the popup opens inside the click either way, so browsers don't
 * block it.
 */

export type CheckoutStatus =
  | "idle"
  /** Your createSession is running (the popup shows a loading page). */
  | "creating"
  /** The checkout is open. */
  | "open"
  /** Navigating to the checkout (phones, or a blocked popup). */
  | "redirecting"
  | "completed"
  | "canceled"
  | "closed"
  | "expired"
  | "timeout"
  | "error";

export type UsePolarisCheckoutOptions = PolarisClientProps &
  Pick<PolarisOptions, "fetch"> &
  Pick<OpenCheckoutOptions, "display" | "timeoutMs" | "onBlocked" | "overlay"> & {
    onResult?: (result: CheckoutResult) => void;
    onError?: (error: PolarisError) => void;
  };

export type UsePolarisCheckout = {
  status: CheckoutStatus;
  result: CheckoutResult | null;
  error: PolarisError | null;
  /** True while creating or open. */
  busy: boolean;
  /** Open the checkout. Resolves with the result, or null if it failed (see `error`). */
  open(source: CheckoutSource, options?: OpenCheckoutOptions): Promise<CheckoutResult | null>;
  /** Navigate to the checkout instead of a popup. */
  redirect(target: CheckoutTarget): void;
  /** Close an open checkout. */
  cancel(): void;
  reset(): void;
  polaris: Polaris;
};

function toPolarisError(err: unknown): PolarisError {
  if (isPolarisError(err)) return err;
  return new PolarisError(err instanceof Error ? err.message : "Couldn't start the checkout.", {
    type: "checkout_error",
    code: "create_session_failed",
    cause: err,
  });
}

export function usePolarisCheckout(options: UsePolarisCheckoutOptions = {}): UsePolarisCheckout {
  const polaris = usePolarisClient(options);
  const [status, setStatus] = useState<CheckoutStatus>("idle");
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [error, setError] = useState<PolarisError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const open = useCallback(
    async (source: CheckoutSource, openOptions: OpenCheckoutOptions = {}): Promise<CheckoutResult | null> => {
      const opts = latest.current;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setError(null);
      setResult(null);

      const pending = typeof source === "function" || (source && typeof (source as Promise<unknown>).then === "function");
      setStatus(pending ? "creating" : "open");

      // Report "open" once the session exists; the popup itself opens synchronously.
      const tracked: CheckoutSource = pending
        ? () =>
            Promise.resolve(typeof source === "function" ? source() : (source as Promise<CheckoutTarget>)).then((target) => {
              if (mounted.current && abortRef.current === controller) setStatus("open");
              return target;
            })
        : source;

      try {
        const outcome = await polaris.openCheckout(tracked, {
          display: opts.display,
          timeoutMs: opts.timeoutMs,
          onBlocked: opts.onBlocked,
          overlay: opts.overlay,
          signal: controller.signal,
          ...openOptions,
        });
        if (mounted.current) {
          setResult(outcome);
          setStatus(outcome.status === "redirected" ? "redirecting" : outcome.status);
        }
        opts.onResult?.(outcome);
        return outcome;
      } catch (err) {
        const e = toPolarisError(err);
        if (mounted.current) {
          setError(e);
          setStatus("error");
        }
        opts.onError?.(e);
        return null;
      }
    },
    [polaris],
  );

  const redirect = useCallback(
    (target: CheckoutTarget) => {
      setStatus("redirecting");
      try {
        polaris.redirectToCheckout(target);
      } catch (err) {
        const e = toPolarisError(err);
        setError(e);
        setStatus("error");
        latest.current.onError?.(e);
      }
    },
    [polaris],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus("idle");
    setResult(null);
    setError(null);
  }, []);

  return { status, result, error, busy: status === "creating" || status === "open" || status === "redirecting", open, redirect, cancel, reset, polaris };
}
