"use client";

import { animate, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { DrawLine } from "@/components/motion/DrawLine";
import { Grow, GrowAnchor } from "@/components/motion/Grow";
import { useReduced, useReveal } from "@/components/motion/hooks";
import { Rise } from "@/components/motion/Rise";
import { RollingNumber } from "@/components/motion/RollingNumber";
import { EASE_REVEAL } from "@/components/motion/tokens";
import { Button } from "@/components/ui/Button";
import { LeafArrowDoodle } from "@/components/ui/Doodles";
import { pricing } from "@/content";
import { formatUsd, formatUsdWhole } from "@/lib/format";

/**
 * 5. "0.5% per payment. No hidden fees.": the copy on the left and the lime
 * calculator on the right. The card grows up from a thin pill with its
 * contents riding up on the top edge; on first view the slider travels from
 * 0 to 25% and the numbers tween after it.
 */
export function Pricing() {
  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="py-28 md:py-36 lg:pb-[100px] lg:pt-[182px]">
      <div className="shell-narrow grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,493px)] lg:gap-16">
        <div>
          <BlurWords id="pricing-heading" as="h2" text={pricing.heading} className="heading text-h2 text-olive" />
          <BlurLines
            text={pricing.body}
            delay={0.25}
            className="mt-8 max-w-[540px] text-[18px] leading-[1.25] tracking-[-0.025em] text-olive lg:mt-[46px] lg:text-[clamp(18px,1.67vw,24px)]"
          />
          <Rise y={14} delay={0.45} className="mt-9 lg:mt-[56px]">
            <Button href={pricing.cta.href} arrow reveal={{ delay: 0.5 }}>
              {pricing.cta.label}
            </Button>
          </Rise>
        </div>
        <Calculator />
      </div>
    </section>
  );
}

function Calculator() {
  const c = pricing.calculator;
  const reduced = useReduced();
  const [ref, inView] = useReveal<HTMLDivElement>(0.35);
  const [sales, setSales] = useState(0);
  const touched = useRef(false);
  const inputId = useId();

  // First view: the slider travels from 0 to about 25%.
  useEffect(() => {
    if (!inView || touched.current) return;
    const target = c.max * c.intro;
    if (reduced) {
      setSales(target);
      return;
    }
    const controls = animate(0, target, {
      delay: 1.05,
      duration: 1.5,
      ease: [0.65, 0, 0.35, 1],
      onUpdate: (v) => {
        if (!touched.current) setSales(Math.round(v / c.step) * c.step);
      },
    });
    return () => controls.stop();
  }, [inView, reduced, c.max, c.intro, c.step]);

  const keep = sales * (1 - c.feeRate);
  const cards = sales > 0 ? sales * c.cardRate + c.cardFixed * c.orders : 0;
  const pct = c.max > 0 ? sales / c.max : 0;

  return (
    <Grow
      from={0.07}
      duration={1.15}
      className="relative overflow-hidden rounded-card bg-lime px-6 pb-8 pt-7 text-olive md:px-[31px] md:pb-[30px] md:pt-[27px] lg:min-h-[523px]"
    >
      <GrowAnchor className="pointer-events-none absolute inset-0">
        <motion.div
          aria-hidden="true"
          className="rv absolute -right-1 -top-1 w-[104px] text-olive/[0.16]"
          initial={{ opacity: 0, rotate: -12, scale: 0.85 }}
          animate={inView ? { opacity: 1, rotate: 0, scale: 1 } : undefined}
          transition={{ delay: 0.6, duration: 1.2, ease: EASE_REVEAL }}
        >
          <LeafArrowDoodle className="h-auto w-full" />
        </motion.div>
      </GrowAnchor>

      {/* Everything in the card belongs to its top edge and rides up with it */}
      <div ref={ref}>
        <GrowAnchor>
          <BlurWords as="h3" text={c.title} delay={0.45} play={inView} className="text-[22px] tracking-[-0.03em] lg:text-[28px]" />
          <DrawLine
            play={inView}
            delay={0.55}
            className="mt-[24px] h-px w-full bg-[linear-gradient(90deg,rgba(45,58,2,0.16),rgba(45,58,2,0.16)_70%,rgba(45,58,2,0))]"
          />

          <label htmlFor={inputId} className="mt-8 block lg:mt-[28px]">
            <BlurWords text={c.salesLabel} delay={0.6} play={inView} className="text-[18px] tracking-[-0.025em] lg:text-[24px]" />
          </label>
          <Rise y={10} blur={10} delay={0.75} play={inView}>
            <RollingNumber
              value={sales}
              format={formatUsd}
              className="mt-3 block text-[48px] font-medium leading-none tracking-[-0.05em] lg:mt-[20px] lg:text-[clamp(48px,4.25vw,61px)]"
            />
          </Rise>

          <Slider id={inputId} value={sales} max={c.max} step={c.step} pct={pct} show={inView} onChange={(v) => {
            touched.current = true;
            setSales(v);
          }} />

          <DrawLine
            play={inView}
            delay={0.7}
            className="mt-8 h-px w-full bg-[linear-gradient(90deg,rgba(45,58,2,0.16),rgba(45,58,2,0.16)_70%,rgba(45,58,2,0))] lg:mt-[36px]"
          />

          <div className="mt-7 grid grid-cols-2 gap-5 lg:mt-[32px]">
            <div>
              <BlurWords text={c.keep} delay={0.8} play={inView} className="text-[17px] tracking-[-0.025em] lg:text-[24px]" />
              <Rise y={10} blur={10} delay={0.85} play={inView}>
                <RollingNumber
                  value={keep}
                  format={formatUsdWhole}
                  className="mt-2 block text-[30px] font-medium leading-none tracking-[-0.045em] lg:mt-3 lg:text-[clamp(30px,2.9vw,42px)]"
                />
              </Rise>
            </div>
            <div>
              <BlurWords text={c.cards} delay={0.88} play={inView} className="text-[17px] tracking-[-0.025em] text-olive/60 lg:text-[24px]" />
              <Rise y={10} blur={10} delay={0.93} play={inView}>
                <RollingNumber
                  value={cards}
                  format={formatUsdWhole}
                  className="mt-2 block text-[30px] font-medium leading-none tracking-[-0.045em] text-olive/45 lg:mt-3 lg:text-[clamp(30px,2.9vw,42px)]"
                />
              </Rise>
            </div>
          </div>
          <BlurLines text={c.footnote} delay={1} play={inView} className="mt-5 text-[12px] tracking-[-0.01em] text-olive/55" />
        </GrowAnchor>
      </div>
    </Grow>
  );
}

function Slider({
  id,
  value,
  max,
  step,
  pct,
  show,
  onChange,
}: {
  id: string;
  value: number;
  max: number;
  step: number;
  pct: number;
  show: boolean;
  onChange: (v: number) => void;
}) {
  const knob = `calc((100% - 20px) * ${pct})`;
  return (
    <div className="relative mt-8 h-[26px] lg:mt-[38px]">
      <motion.div
        aria-hidden="true"
        className="rv absolute inset-x-0 top-1/2 h-[11px] -translate-y-1/2 origin-left bg-olive/[0.17]"
        initial={{ scaleX: 0 }}
        animate={show ? { scaleX: 1 } : undefined}
        transition={{ delay: 0.8, duration: 0.8, ease: EASE_REVEAL }}
      >
        <div className="h-full bg-olive" style={{ width: `calc(${knob} + 10px)` }} />
      </motion.div>
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-valuetext={formatUsd(value)}
        className="range-input peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
      <motion.div
        aria-hidden="true"
        className="rv pointer-events-none absolute top-1/2 h-[24px] w-[20px] -translate-y-1/2 rounded-[3px] bg-olive outline-offset-2 peer-focus-visible:outline-2 peer-focus-visible:outline-olive"
        style={{ left: knob }}
        initial={{ scale: 0, opacity: 0 }}
        animate={show ? { scale: 1, opacity: 1 } : undefined}
        transition={{ delay: 1.0, type: "spring", stiffness: 380, damping: 18 }}
      />
    </div>
  );
}
