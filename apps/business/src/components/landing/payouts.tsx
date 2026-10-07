"use client";

import {
  BalanceSummaryCard,
  DollarCoin,
  Money,
  PolarisCoin,
  PrimaryButton,
  StatusPill,
  SwapCard,
  SwapStack,
  TextTabs,
  Toggle,
} from "@polaris/ui";
import { ArrowUpFromLine, Check, Fuel, Send, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { Rise } from "@/components/motion";
import { money } from "@/lib/data/format";
import { payouts } from "./content";
import { SectionIntro, Shell } from "./section";

const ICONS = [<Send key="send" size={18} />, <Fuel key="fuel" size={18} />, <ShieldCheck key="shield" size={18} />];
const START = 6_274_50;
const AMOUNT = 1_250_00;

/** "Easy withdraw": ref E's WITHDRAW widget, a one-tap withdrawal and the daily sweep, as a demo. */
export function Payouts() {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [auto, setAuto] = useState(false);
  const [tab, setTab] = useState<"once" | "daily">("once");
  const [balance, setBalance] = useState(START);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const withdraw = () => {
    if (state !== "idle") return;
    setState("sending");
    timers.current.push(
      setTimeout(() => {
        setState("sent");
        setBalance((b) => Math.max(0, b - AMOUNT));
      }, 800),
      setTimeout(() => {
        setState("idle");
        setBalance(START);
      }, 5200),
    );
  };

  return (
    <section id="payouts" aria-labelledby="payouts-title" className="scroll-mt-24 py-20 lg:py-28">
      <Shell className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <Rise y={32} blur={8} duration={0.9} className="order-2 min-w-0 lg:order-1">
          <div className="mx-auto grid max-w-[460px] gap-3 rounded-[32px] border border-ui-hairline-strong p-4 sm:p-6">
            <div className="mb-2 flex min-h-10 items-center justify-between gap-3">
              <TextTabs
                size="auto"
                aria-label="How you withdraw"
                options={[
                  { value: "once", label: "Withdraw" },
                  { value: "daily", label: "Daily" },
                ]}
                value={tab}
                onValueChange={setTab}
              />
              <StatusPill tone="neutral" size="sm">
                Demo · nothing moves
              </StatusPill>
            </div>
            {tab === "once" ? (
              <>
                <SwapStack
                  top={<SwapCard coin={<PolarisCoin size={42} />} symbol="AUSD" caption="You send" amount="1,250.00" metaLabel="Balance" meta={(balance / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} />}
                  bottom={<SwapCard coin={<DollarCoin size={42} />} symbol="USD" caption="Arrives" amount="1,250.00" metaLabel="To" meta="0x7a3f…91c2" />}
                />
                <div aria-live="polite" className="mt-1">
                  <AnimatePresence mode="wait" initial={false}>
                    {state === "idle" ? (
                      <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        <PrimaryButton size="lg" block icon={<ArrowUpFromLine />} onClick={withdraw}>
                          Withdraw {money(AMOUNT)}
                        </PrimaryButton>
                      </motion.div>
                    ) : (
                      <motion.p
                        key={state}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="flex h-[50px] items-center justify-center gap-3 rounded-full bg-ui-surface-1 text-[15px] font-medium"
                      >
                        {state === "sending" ? (
                          <span className="size-6 animate-spin rounded-full border-[3px] border-ui-surface-3 border-t-ui-lime-button motion-reduce:animate-none" />
                        ) : (
                          <span className="grid size-6 place-items-center rounded-full bg-ui-lime-button text-[#121418]">
                            <Check size={14} strokeWidth={2.5} aria-hidden />
                          </span>
                        )}
                        {state === "sending" ? "Confirm once, the relayer sends it…" : "Sent in 0.8 s. Network fee: $0.00"}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>
              </>
            ) : (
              <div className="rounded-ui-swap bg-ui-surface-1 px-5 py-4">
                <Toggle
                  checked={auto}
                  onCheckedChange={setAuto}
                  label="Automatic daily payouts"
                  description={
                    auto
                      ? "Every day at 17:00 UTC, to 0x7a3f…91c2 only. A Privy session signer does it, so you never sign again."
                      : "Sweep your balance every day to one address you choose."
                  }
                />
              </div>
            )}
            <BalanceSummaryCard
              label="Available balance"
              value={<Money value={balance / 100} />}
              delta={11.05}
              deltaSuffix="this week"
              stats={[
                { label: "Network fee", value: "$0.00" },
                { label: "You receive", value: money(AMOUNT) },
                { label: "Settles in", value: "0.8 s" },
              ]}
            />
          </div>
        </Rise>

        <div className="order-1 lg:order-2">
          <SectionIntro id="payouts-title" eyebrow={payouts.eyebrow} heading={payouts.heading} sub={payouts.sub} />
          <ul className="mt-10 grid gap-5">
            {payouts.features.map((f, i) => (
              <Rise as="li" key={f.title} y={14} delay={0.15 + i * 0.1} className="grid grid-cols-[44px_minmax(0,1fr)] gap-4">
                <span className="grid size-11 place-items-center rounded-[14px] border border-ui-hairline-strong bg-ui-square text-ui-lime-text">{ICONS[i]}</span>
                <span>
                  <span className="block text-[18px] font-medium tracking-[-0.015em]">{f.title}</span>
                  <span className="mt-1 block text-[15px] leading-[1.5] text-ui-muted">{f.body}</span>
                </span>
              </Rise>
            ))}
          </ul>
        </div>
      </Shell>
    </section>
  );
}
