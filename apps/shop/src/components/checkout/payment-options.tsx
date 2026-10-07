"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";

import { WalletIcon } from "@/components/icons";
import { formatUsd } from "@/lib/money";
import { aprLabel, payIn4 } from "@/lib/pay-in-4";
import { PolarisLockup } from "@/components/polaris-lockup";

export type Method = "polaris" | "wallet";
export type Mode = "now" | "later" | "subscribe";

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function Radio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full transition-shadow ${
        checked ? "shadow-[inset_0_0_0_6px_var(--color-ink)]" : "shadow-[inset_0_0_0_1.5px_var(--color-hair-strong)]"
      }`}
    />
  );
}

/** Opens a payment option's details. Rendered on the server too, so it never branches on the motion preference. */
function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function PaymentOptions({
  method,
  onMethod,
  mode,
  onMode,
  kind,
  total,
  aprBps,
  hasWallet,
  coarsePointer,
  walletPanel,
  payInFourPaused = null,
}: {
  method: Method;
  onMethod: (m: Method) => void;
  mode: Mode;
  onMode: (m: Mode) => void;
  kind: "one_time" | "subscription";
  total: number;
  aprBps: number;
  /** null until the browser has been checked for window.ethereum. */
  hasWallet: boolean | null;
  /** A touch screen: phones get a full-page redirect to Polaris, and rarely have a browser wallet. */
  coarsePointer: boolean;
  walletPanel: ReactNode;
  /** Polaris's risk guard has paused new Pay in 4 plans: its sentence, shown in place of the plan. */
  payInFourPaused?: string | null;
}) {
  const name = useId();
  const modeName = useId();

  const plan = payIn4(total, aprBps);
  const opens = coarsePointer
    ? "Polaris opens to confirm, then brings you back here. You don\u2019t need a card."
    : "Polaris opens in its own window to confirm. You don\u2019t need a card.";
  const [today] = useState(() => Date.now());
  const payInFourAllowed = total >= 5000;

  const modes: { id: Mode; title: string; detail: string }[] =
    kind === "subscription"
      ? [{ id: "subscribe", title: "Subscribe", detail: `${formatUsd(total)} a month` }]
      : [
          { id: "now", title: "Pay now", detail: formatUsd(total) },
          { id: "later", title: "Pay in 4", detail: payInFourPaused ? "Paused" : plan ? `4 × ${formatUsd(plan.each)}` : "" },
        ];

  const walletDisabled = kind === "subscription";

  return (
    <div role="radiogroup" aria-label="Payment method" className="mt-5 overflow-hidden rounded-2xl bg-paper shadow-[inset_0_0_0_1px_var(--color-hair-strong)]">
      {/* Polaris */}
      <div className={`transition-colors ${method === "polaris" ? "bg-paper" : ""}`}>
        <label className="flex cursor-pointer items-center gap-4 px-5 py-5 sm:px-6 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-sage">
          <input type="radio" name={name} className="sr-only" checked={method === "polaris"} onChange={() => onMethod("polaris")} />
          <Radio checked={method === "polaris"} />
          <span className="flex flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <PolarisLockup className="text-[1.08rem]" />
            <span className="text-[0.9rem] text-muted">
              {kind === "subscription" ? "Monthly, cancel any time" : payInFourPaused ? "Pay now in full" : `Pay now, or in 4 payments at ${aprLabel(aprBps)}`}
            </span>
          </span>
        </label>
        <Expand open={method === "polaris"}>
          <div className="px-5 pb-6 sm:px-6 sm:pl-[3.75rem]">
            <div role="radiogroup" aria-label="How to pay with Polaris" className={`grid gap-2 ${modes.length > 1 ? "sm:grid-cols-2" : ""}`}>
              {modes.map((m) => {
                const checked = mode === m.id;
                const disabled = m.id === "later" && (!payInFourAllowed || Boolean(payInFourPaused));
                return (
                  <label
                    key={m.id}
                    className={`relative flex cursor-pointer items-center justify-between gap-3 rounded-xl px-4 py-3.5 transition-[box-shadow,background-color] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sage ${
                      checked ? "bg-ground shadow-[inset_0_0_0_1.5px_var(--color-ink)]" : "shadow-[inset_0_0_0_1px_var(--color-hair-strong)] hover:shadow-[inset_0_0_0_1px_var(--color-ink)]"
                    } ${disabled ? "pointer-events-none opacity-50" : ""}`}
                  >
                    <input type="radio" name={modeName} className="sr-only" checked={checked} disabled={disabled} onChange={() => onMode(m.id)} />
                    <span className="font-medium">{m.title}</span>
                    <span className="num text-[0.95rem] text-ink-2">{m.detail}</span>
                  </label>
                );
              })}
            </div>

            {kind !== "subscription" && payInFourPaused ? (
              <p role="status" className="mt-4 rounded-xl bg-sand px-4 py-3 text-[0.92rem] leading-relaxed text-ink">
                {payInFourPaused}
              </p>
            ) : null}

            {mode === "later" && plan && !payInFourPaused ? (
              <div className="mt-5">
                <p className="text-[0.9rem] font-medium text-ink">Nothing to pay today. Then:</p>
                <ol className="mt-3 grid grid-cols-4 gap-2" aria-label="Pay in 4 schedule">
                  {plan.installments.map((inst) => (
                    <li key={inst.index} className="grid gap-1.5 text-[0.82rem] text-muted" suppressHydrationWarning>
                      <span className="h-1 rounded-full bg-hair-strong" />
                      <span className="num text-[0.95rem] font-medium text-ink">{formatUsd(inst.amount)}</span>
                      {SHORT_DATE.format(new Date(today + inst.dueInSeconds * 1000))}
                    </li>
                  ))}
                </ol>
                <p className="num mt-4 text-[0.9rem] leading-relaxed text-muted">
                  {`${formatUsd(plan.interest)} interest (${aprLabel(plan.aprBps)}), ${formatUsd(plan.total)} in total. `}
                  Halcyon is paid in full today. {opens}
                </p>
              </div>
            ) : mode === "subscribe" ? (
              <p className="mt-4 text-[0.9rem] leading-relaxed text-muted" suppressHydrationWarning>
                {formatUsd(total)} today, then on the {ordinal(new Date(today).getDate())} of every month. Skip or cancel any time. {opens}
              </p>
            ) : (
              <p className="mt-4 text-[0.9rem] leading-relaxed text-muted">
                Pay the full {formatUsd(total)} now, confirmed with Face ID. {opens}
              </p>
            )}
          </div>
        </Expand>
      </div>

      <div className="border-t border-hair" />

      {/* Direct wallet payment */}
      <div className={walletDisabled ? "opacity-60" : ""}>
        <label className={`flex items-center gap-4 px-5 py-5 sm:px-6 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-sage ${walletDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={method === "wallet"}
            disabled={walletDisabled}
            onChange={() => onMethod("wallet")}
          />
          <Radio checked={method === "wallet"} />
          <span className="flex flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-2 text-[1.02rem] font-medium">
              <WalletIcon size={20} /> Pay directly with a wallet
            </span>
            <span className="text-[0.9rem] text-muted">{walletDisabled ? "Not for subscriptions" : "AUSD on Monad, no gas"}</span>
          </span>
        </label>
        <Expand open={method === "wallet"}>
          <div className="px-5 pb-6 sm:px-6 sm:pl-[3.75rem]">
            <p className="text-[0.92rem] leading-relaxed text-ink-2">
              Pay {formatUsd(total)} in AUSD from any browser wallet on Monad Testnet. You sign once; Polaris sends the payment, so you pay no
              gas.
            </p>
            {hasWallet === false ? (
              <p className="mt-3 rounded-lg bg-sand px-3.5 py-2.5 text-[0.88rem] text-ink-2">
                {coarsePointer
                  ? "There\u2019s no wallet in this browser. Open this page in your wallet app\u2019s browser, or pay with Polaris above."
                  : "There\u2019s no wallet in this browser. Install one such as MetaMask or Rabby, or pay with Polaris above."}
              </p>
            ) : null}
            {walletPanel}
          </div>
        </Expand>
      </div>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

