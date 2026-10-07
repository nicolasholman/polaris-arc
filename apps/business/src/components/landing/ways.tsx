"use client";

import { Money, StatusPill, Ticks, cn } from "@polaris/ui";
import { CalendarClock, Check, Layers, Zap } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { Rise, useReduced, useReveal } from "@/components/motion";
import { EASE_REVEAL } from "@/components/motion/tokens";
import { money, payInFourQuote } from "@/lib/data/format";
import { ways } from "./content";
import { SectionIntro, Shell } from "./section";

const quote = payInFourQuote(200_00);

/** "One link, three ways to pay": a card per mode, each with a small live visual. */
export function Ways() {
  return (
    <section id="ways" aria-labelledby="ways-title" className="scroll-mt-24 py-20 lg:py-28">
      <Shell>
        <SectionIntro id="ways-title" eyebrow={ways.eyebrow} heading={ways.heading} sub={ways.sub} />
        <div className="mt-12 grid gap-4 md:grid-cols-3 lg:mt-16">
          {ways.cards.map((card, i) => (
            <Rise key={card.key} delay={0.12 * i} className="h-full">
              <article className="flex h-full flex-col rounded-[30px] border border-ui-hairline-strong p-3">
                <div className="h-[236px] overflow-hidden rounded-[24px] bg-ui-surface-1">
                  {card.key === "now" ? <PayNowVisual /> : card.key === "later" ? <PayIn4Visual /> : <SubscribeVisual />}
                </div>
                <div className="flex flex-1 flex-col px-3 pt-5 pb-3">
                  <h3 className="flex items-center gap-2.5 text-[22px] font-medium tracking-[-0.025em]">
                    <ModeIcon mode={card.key} />
                    {card.title}
                  </h3>
                  <p className="mt-2 text-[15px] leading-[1.5] text-ui-muted">{card.body}</p>
                  <p className="mt-auto pt-5 text-[14px] font-medium text-ui-text">{card.foot}</p>
                </div>
              </article>
            </Rise>
          ))}
        </div>
      </Shell>
    </section>
  );
}

function ModeIcon({ mode }: { mode: "now" | "later" | "subscribe" }) {
  const icon = mode === "now" ? <Zap size={16} /> : mode === "later" ? <Layers size={16} /> : <CalendarClock size={16} />;
  const tone = mode === "now" ? "bg-[#a9c350] text-white" : mode === "later" ? "bg-[#9a6ad6] text-white" : "bg-[#4fb3ac] text-white";
  return <span className={cn("grid size-8 place-items-center rounded-full", tone)}>{icon}</span>;
}

/** Pay now: the order settles, a bar runs to 0.8 s, and it turns Paid. */
function PayNowVisual() {
  const [ref, seen] = useReveal<HTMLDivElement>(0.5);
  const reduced = useReduced();
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    if (!seen) return;
    const t = setTimeout(() => setPaid(true), reduced ? 0 : 1100);
    return () => clearTimeout(t);
  }, [seen, reduced]);

  return (
    <div ref={ref} className="relative flex h-full flex-col justify-center gap-4 px-5">
      <Row label="Brand identity package" right={<Money value={200} dim="cents" className="text-[17px] font-medium" />} />
      <div className="relative">
        <div className="h-2 overflow-hidden rounded-full bg-ui-canvas">
          <motion.div
            className="h-full rounded-full bg-ui-lime-button"
            initial={{ width: "0%" }}
            animate={{ width: seen ? "100%" : "0%" }}
            transition={{ duration: reduced ? 0 : 0.8, delay: reduced ? 0 : 0.25, ease: "linear" }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[12px] text-ui-muted">
          <span>Confirm</span>
          <span className="ui-figure">0.8 s</span>
        </div>
      </div>
      <motion.div
        animate={{ opacity: paid ? 1 : 0.35, scale: paid ? 1 : 0.98 }}
        transition={{ duration: 0.35, ease: EASE_REVEAL }}
        className="flex items-center justify-between rounded-[18px] bg-ui-canvas px-4 py-3"
      >
        <span className="flex items-center gap-2.5 text-[15px] font-medium">
          <span className={cn("grid size-7 place-items-center rounded-full", paid ? "bg-ui-lime-button text-[#121418]" : "bg-ui-surface-2 text-ui-muted")}>
            <Check size={15} strokeWidth={2.5} aria-hidden />
          </span>
          {paid ? "Paid to you" : "Settling"}
        </span>
        <StatusPill tone={paid ? "lime" : "neutral"} size="sm">{paid ? "Final" : "…"}</StatusPill>
      </motion.div>
    </div>
  );
}

/** Pay in 4: four ticks fill week by week; you were paid in full at the start. */
function PayIn4Visual() {
  const [ref, seen] = useReveal<HTMLDivElement>(0.5);
  const reduced = useReduced();
  const [ticked, setTicked] = useState(0);
  useEffect(() => {
    if (!seen || reduced) return;
    const timers = [1, 2, 3, 4].map((n) => setTimeout(() => setTicked(n), 350 + n * 420));
    return () => timers.forEach(clearTimeout);
  }, [seen, reduced]);
  // Reduced motion: all four ticks at once, no timers.
  const done = reduced && seen ? 4 : ticked;

  return (
    <div ref={ref} className="flex h-full flex-col justify-between p-5 text-ui-text">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[14px] text-ui-muted">The buyer pays</p>
          <p className="ui-figure mt-1 text-[34px] leading-none font-medium tracking-[-0.035em]">4 × {money(quote.each)}</p>
        </div>
        <StatusPill tone="purple" size="sm">
          10% APR
        </StatusPill>
      </div>
      <div className="grid gap-2">
        <Ticks done={done} total={4} label={`${done} of 4 payments collected`} />
        <div className="grid grid-cols-4 text-[11px] text-ui-muted">
          {["Week 1", "Week 2", "Week 3", "Week 4"].map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between rounded-[18px] bg-ui-canvas px-4 py-3 text-[15px] font-medium">
        <span>You got, at checkout</span>
        <Money value={200} dim="none" />
      </div>
    </div>
  );
}

/** Subscribe: monthly charges, and a missed month skipped rather than stacked. */
function SubscribeVisual() {
  const [ref, seen] = useReveal<HTMLDivElement>(0.5);
  const reduced = useReduced();
  const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
  const skipped = 3;
  return (
    <div ref={ref} className="flex h-full flex-col justify-between p-5 text-ui-text">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[14px] text-ui-muted">Social kit, monthly</p>
          <p className="ui-figure mt-1 text-[34px] leading-none font-medium tracking-[-0.035em]">
            $120<span className="text-ui-muted">.00</span>
          </p>
        </div>
        <StatusPill tone="teal" size="sm">
          Every month
        </StatusPill>
      </div>
      <ol className="grid grid-cols-6 gap-2">
        {months.map((m, i) => (
          <li key={m} className="flex flex-col items-center gap-2">
            <motion.span
              initial={{ scale: 0.4, opacity: 0 }}
              animate={seen ? { scale: 1, opacity: 1 } : { scale: 0.4, opacity: 0 }}
              transition={{ delay: reduced ? 0 : 0.2 + i * 0.12, type: "spring", stiffness: 420, damping: 22 }}
              className={cn(
                "grid size-9 place-items-center rounded-full text-[12px] font-semibold",
                i === skipped ? "border-2 border-dashed border-ui-hairline-strong text-ui-muted" : "bg-ui-pill-teal text-ui-pill-teal-text",
              )}
            >
              {i === skipped ? "–" : <Check size={14} strokeWidth={2.5} aria-hidden />}
            </motion.span>
            <span className="text-[11px] text-ui-muted">{m}</span>
          </li>
        ))}
      </ol>
      <p className="text-[13px] leading-snug text-ui-muted">Missed August? It&rsquo;s skipped. September charges one month, not two.</p>
    </div>
  );
}

function Row({ label, right }: { label: string; right: ReactNode }) {
  return (
    <div className="relative flex items-center justify-between gap-3">
      <span className="truncate text-[15px] text-ui-muted">{label}</span>
      {right}
    </div>
  );
}
