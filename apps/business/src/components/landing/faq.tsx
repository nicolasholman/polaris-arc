"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

import { BlurLines, BlurWords, DrawLine, Rise, useReduced, useReveal } from "@/components/motion";
import { ACCORDION_DURATION, EASE_REVEAL } from "@/components/motion/tokens";
import { faq } from "./content";
import { Shell } from "./section";

/**
 * The FAQ, in apps/landing's pattern: heading and sub on the left, an
 * accordion with drawn hairlines on the right; the first item opens by
 * itself when the section comes into view.
 */
export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className="scroll-mt-24 py-20 lg:py-28">
      <Shell className="grid gap-12 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <div>
          <BlurWords id="faq-heading" as="h2" text={faq.heading} className="text-[clamp(38px,4.8vw,68px)] leading-[1.02] font-medium tracking-[-0.045em]" />
          <BlurLines text={faq.sub} delay={0.3} className="mt-5 max-w-[420px] text-[17px] leading-[1.5] text-ui-muted lg:text-[19px]" />
        </div>
        <FaqList />
      </Shell>
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
    <div ref={ref}>
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
                  className="group flex w-full items-center justify-between gap-6 rounded-[12px] pt-6 pb-4 text-left text-[20px] leading-[1.25] tracking-[-0.025em] lg:text-[24px]"
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
                  <BlurLines text={item.a} play delay={0.05} stagger={0.07} className="max-w-[640px] pb-6 text-[16px] leading-[1.55] text-ui-muted lg:text-[17px]" />
                </motion.div>
              ) : null}
            </AnimatePresence>
            {i < faq.items.length - 1 ? <DrawLine play={inView} delay={0.2 + i * 0.08} className="mt-1 h-px bg-white/10" /> : null}
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
      className="relative grid size-10 shrink-0 place-items-center rounded-full bg-ui-surface-1 text-ui-lime"
      animate={{ rotate: open ? 180 : 0 }}
      transition={{ duration: ACCORDION_DURATION, ease: EASE_REVEAL }}
    >
      <span className="absolute h-[1.8px] w-4 rounded-full bg-current" />
      <motion.span
        className="absolute h-4 w-[1.8px] rounded-full bg-current"
        animate={{ scaleY: open ? 0 : 1 }}
        transition={{ duration: ACCORDION_DURATION, ease: EASE_REVEAL }}
      />
    </motion.span>
  );
}
