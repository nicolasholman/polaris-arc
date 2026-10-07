"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { DrawLine } from "@/components/motion/DrawLine";
import { useReduced, useReveal } from "@/components/motion/hooks";
import { Rise } from "@/components/motion/Rise";
import { ACCORDION_DURATION, EASE_REVEAL } from "@/components/motion/tokens";
import { faq } from "@/content";

/**
 * 6. FAQ: a full-bleed olive band. Lime heading and muted-lime sub on the
 * left; on the right an accordion with hairline dividers. The first item
 * opens by itself when the section enters; items open and close with height
 * and opacity (350ms) and the plus turns into a minus.
 */
export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className="bg-olive py-24 text-lime md:py-32 lg:py-[176px]">
      <div className="shell grid gap-12 lg:grid-cols-2 lg:gap-0">
        <div className="lg:pr-16">
          <BlurWords id="faq-heading" as="h2" text={faq.heading} className="heading text-h2 text-lime" />
          <BlurLines
            text={faq.sub}
            delay={0.3}
            className="mt-6 max-w-[470px] text-[18px] leading-[1.33] tracking-[-0.025em] text-lime-muted lg:mt-[34px] lg:text-[clamp(18px,1.67vw,24px)]"
          />
        </div>
        <FaqList />
      </div>
    </section>
  );
}

function FaqList() {
  const [open, setOpen] = useState<number | null>(null);
  const [ref, inView] = useReveal<HTMLDivElement>(0.3);
  const autoOpened = useRef(false);
  const reduced = useReduced();
  const baseId = useId();

  useEffect(() => {
    if (!inView || autoOpened.current) return;
    autoOpened.current = true;
    const t = window.setTimeout(() => setOpen((cur) => (cur === null ? 0 : cur)), reduced ? 0 : 750);
    return () => window.clearTimeout(t);
  }, [inView, reduced]);

  return (
    <div ref={ref} className="lg:-mt-[30px]">
      {faq.items.map((item, i) => {
        const isOpen = open === i;
        const panelId = `${baseId}-panel-${i}`;
        const buttonId = `${baseId}-button-${i}`;
        return (
          <div key={item.q}>
            <Rise y={18} blur={8} delay={0.1 + i * 0.08} play={inView} duration={0.7}>
              <h3>
                <button
                  id={buttonId}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="group flex w-full items-center justify-between gap-6 pb-4 pt-6 text-left text-[20px] leading-[1.2] tracking-[-0.03em] text-lime lg:pb-[18px] lg:pt-[30px] lg:text-[clamp(20px,1.95vw,28px)]"
                >
                  <span className="transition-opacity group-hover:opacity-80">{item.q}</span>
                  <PlusMinus open={isOpen} />
                </button>
              </h3>
            </Rise>
            <AnimatePresence initial={false}>
              {isOpen ? (
                <motion.div
                  key="panel"
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  className="overflow-hidden"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: ACCORDION_DURATION, ease: EASE_REVEAL }}
                >
                  <BlurLines
                    text={item.a}
                    play
                    delay={0.05}
                    stagger={0.07}
                    className="max-w-[690px] pb-5 text-[16px] leading-[1.5] tracking-[-0.02em] text-lime-muted lg:pb-[30px] lg:text-[clamp(16px,1.46vw,21px)]"
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
            {i < faq.items.length - 1 ? (
              <DrawLine play={inView} delay={0.2 + i * 0.08} className="mx-[15px] mt-2 h-px bg-lime/[0.16] lg:mt-3" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A plus whose vertical stroke folds away as it turns, leaving a minus. */
function PlusMinus({ open }: { open: boolean }) {
  return (
    <motion.span
      aria-hidden="true"
      className="relative block h-[17px] w-[17px] shrink-0"
      animate={{ rotate: open ? 180 : 0 }}
      transition={{ duration: ACCORDION_DURATION, ease: EASE_REVEAL }}
    >
      <span className="absolute left-0 top-1/2 h-[1.6px] w-full -translate-y-1/2 rounded-full bg-current" />
      <motion.span
        className="absolute left-1/2 top-0 h-full w-[1.6px] -translate-x-1/2 rounded-full bg-current"
        animate={{ scaleY: open ? 0 : 1 }}
        transition={{ duration: ACCORDION_DURATION, ease: EASE_REVEAL }}
      />
    </motion.span>
  );
}
