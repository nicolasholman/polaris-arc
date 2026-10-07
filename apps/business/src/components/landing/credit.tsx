"use client";

import { Avatar, Card, StatusPill } from "@polaris/ui";
import { motion } from "motion/react";

import { CountUp, DrawLine, Rise, useReduced, useReveal } from "@/components/motion";
import { EASE_REVEAL } from "@/components/motion/tokens";
import { credit } from "./content";
import { SectionIntro, Shell } from "./section";

/** "Paid in full today, we carry the credit": settlement, CRE collections, Nansen underwriting. */
export function Credit() {
  return (
    <section id="credit" aria-labelledby="credit-title" className="relative isolate scroll-mt-24 overflow-hidden py-20 lg:py-28">
      <div aria-hidden className="glow-violet absolute top-1/3 -left-60 -z-10 h-[640px] w-[640px]" />
      <Shell className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <div>
          <SectionIntro id="credit-title" eyebrow={credit.eyebrow} heading={credit.heading} sub={credit.sub} />
          <Stats />
        </div>
        <div className="grid content-start gap-4">
          <Flow />
          <Underwriting />
        </div>
      </Shell>
    </section>
  );
}

function Stats() {
  const [ref, seen] = useReveal<HTMLDListElement>(0.4);
  return (
    <dl ref={ref} className="mt-10 grid grid-cols-3 gap-3">
      {credit.stats.map((s, i) => (
        <Rise key={s.label} delay={0.1 * i} className="rounded-[24px] border border-ui-hairline-strong p-4 sm:p-5">
          <dt className="sr-only">{s.label}</dt>
          <dd>
            <CountUp
              value={s.value}
              play={seen}
              duration={1.3}
              format={(n) => `${"prefix" in s ? s.prefix : ""}${n.toFixed(s.decimals)}${"suffix" in s ? s.suffix : ""}`}
              // Three tiles about 125px wide at 1024: a step smaller there, and never wrapped.
              className="ui-figure block text-[30px] leading-none font-medium tracking-[-0.04em] whitespace-nowrap text-ui-lime-active sm:text-[40px] lg:text-[30px] xl:text-[40px]"
            />
            <span aria-hidden className="mt-2 block text-[13px] leading-snug text-ui-muted sm:text-[14px]">
              {s.label}
            </span>
          </dd>
        </Rise>
      ))}
    </dl>
  );
}

function Flow() {
  const [ref, seen] = useReveal<HTMLOListElement>(0.3);
  return (
    <Card padding="lg" className="ring-1 ring-white/5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[19px] font-medium tracking-[-0.02em]">
          A $200 order on <span className="whitespace-nowrap">Pay in 4</span>
        </h3>
        <StatusPill tone="purple" size="sm">
          Chainlink CRE
        </StatusPill>
      </div>
      <ol ref={ref} className="relative mt-5 grid gap-1">
        <DrawLine play={seen} axis="y" duration={1.2} className="absolute top-3 bottom-3 left-[15px] w-px bg-ui-hairline-strong" />
        {credit.flow.map((step, i) => (
          <Rise key={step.title} as="li" y={12} delay={0.15 + i * 0.14} play={seen} className="relative grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-4 py-2.5">
            <span className={`relative z-10 grid size-8 place-items-center rounded-full text-[13px] font-semibold ${i === 1 ? "bg-ui-lime-button text-[#121418]" : "bg-ui-surface-2 text-ui-text"}`}>
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[16px] font-medium">{step.title}</span>
              <span className="mt-0.5 block text-[14px] leading-snug text-ui-muted">{step.body}</span>
            </span>
            <StatusPill tone={i === 1 ? "lime" : i === 2 ? "purple" : i === 3 ? "amber" : "neutral"} size="sm" className="ui-figure mt-0.5 h-6 px-2.5 text-[12px]">
              {step.tag}
            </StatusPill>
          </Rise>
        ))}
      </ol>
    </Card>
  );
}

function Underwriting() {
  const [ref, seen] = useReveal<HTMLUListElement>(0.3);
  const reduced = useReduced();
  const max = Math.max(...credit.underwriting.reasons.map((r) => r.points));
  const total = credit.underwriting.reasons.reduce((s, r) => s + r.points, 0);
  return (
    <Card padding="lg" className="ring-1 ring-white/5">
      <div className="flex items-center gap-3">
        <Avatar name="Kofi Mensah" tone="lilac" size="md" decorative />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[19px] font-medium tracking-[-0.02em]">{credit.underwriting.title}</h3>
          <p className="text-[13px] text-ui-muted">Underwriting from Nansen wallet history</p>
        </div>
        <StatusPill tone="lime" size="sm" className="ui-figure hidden sm:inline-flex">
          +{total}
        </StatusPill>
      </div>
      <ul ref={ref} className="mt-5 grid gap-3">
        {credit.underwriting.reasons.map((r, i) => (
          <li key={r.text} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[14px]">
              <span className="text-ui-text">{r.text}</span>
              <span className="ui-figure shrink-0 font-medium text-ui-lime-text">+{r.points}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-ui-canvas">
              <motion.div
                className="h-full rounded-full bg-ui-lime-button"
                initial={{ width: 0 }}
                animate={{ width: seen ? `${(r.points / max) * 100}%` : 0 }}
                transition={{ duration: reduced ? 0 : 0.9, delay: reduced ? 0 : 0.1 + i * 0.1, ease: EASE_REVEAL }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[13px] leading-relaxed text-ui-muted">{credit.underwriting.note}</p>
    </Card>
  );
}
