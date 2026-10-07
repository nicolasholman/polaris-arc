"use client";

import { AlertIcon, CheckIcon, Spinner } from "@/components/icons";

/** Where a direct wallet payment is: polarispay-sdk's pay() stages, then the store's webhook. */
export type WalletPhase = "idle" | "connecting" | "signing" | "submitting" | "confirming" | "waiting" | "paid" | "error";

const STEPS = [
  { id: "connect", label: "Connect your wallet on Monad Testnet" },
  { id: "sign", label: "Confirm the payment in your wallet" },
  { id: "relay", label: "Polaris sends it, gas-free" },
  { id: "confirm", label: "Payment confirmed" },
] as const;

export const ACTIVE_STEP: Partial<Record<WalletPhase, number>> = {
  connecting: 0,
  signing: 1,
  submitting: 2,
  confirming: 2,
  waiting: 3,
  paid: 4,
};

export function WalletSteps({ phase, error, lastStep }: { phase: WalletPhase; error: string | null; lastStep: number }) {
  const failed = phase === "error";
  const active = failed ? lastStep : ACTIVE_STEP[phase];

  return (
    <div className="mt-5">
      <ol className="space-y-3" aria-label="Wallet payment progress">
        {STEPS.map((step, i) => {
          const done = active !== undefined && i < active;
          const current = active === i;
          const stopped = failed && current;
          return (
            <li key={step.id} className="flex items-center gap-3 text-[0.94rem]" aria-current={current ? "step" : undefined}>
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${
                  stopped ? "bg-alert-soft text-alert" : done ? "bg-ok text-paper" : current ? "bg-ink text-paper" : "shadow-[inset_0_0_0_1.5px_var(--color-hair-strong)]"
                }`}
              >
                {stopped ? <AlertIcon size={15} /> : done ? <CheckIcon size={14} strokeWidth={2} /> : current ? <Spinner size={13} /> : null}
              </span>
              <span className={done || current ? "text-ink" : "text-faint"}>
                {step.id === "confirm" && phase === "paid" ? "Paid" : step.label}
                {step.id === "confirm" && phase === "waiting" ? <span className="text-muted"> · waiting for Polaris</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {error ? (
        <p role="alert" className="mt-4 flex gap-2.5 rounded-lg bg-alert-soft px-3.5 py-3 text-[0.9rem] text-alert">
          <AlertIcon size={18} className="mt-px shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
