"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { useReduced, useReveal } from "@/components/motion/hooks";
import { ProgressRing } from "@/components/motion/ProgressRing";
import { EASE_REVEAL } from "@/components/motion/tokens";
import { fallbacks } from "@/components/ui/fallbacks";
import { ArrowLeft, ArrowRight } from "@/components/ui/icons";
import { SmartImage } from "@/components/ui/SmartImage";
import { testimonials } from "@/content";
import type { Assets } from "@/lib/assets";

/**
 * 7. Testimonial: a full-bleed photo with a soft green blur rising from the
 * bottom left. The name and role in lime, then a large lime quote that
 * reveals line by line. Round prev/next buttons at the bottom right; the next
 * button's ring draws over the 6s autoplay interval, then advances. Autoplay
 * pauses on hover and focus, and stops for good once it has shown every
 * quote once (back on the first), so it never runs on indefinitely.
 */
export function Testimonial({ assets }: { assets: Assets }) {
  const { items, intervalMs } = testimonials;
  const [index, setIndex] = useState(0);
  const [ref, inView] = useReveal<HTMLElement>(0.35);
  const reduced = useReduced();
  const [paused, setPaused] = useState(false);
  const [autoTurns, setAutoTurns] = useState(0);
  const autoplay = autoTurns < items.length;

  const next = useCallback(() => setIndex((i) => (i + 1) % items.length), [items.length]);
  const autoNext = useCallback(() => {
    setAutoTurns((n) => n + 1);
    next();
  }, [next]);
  const prev = useCallback(() => setIndex((i) => (i - 1 + items.length) % items.length), [items.length]);
  const item = items[index] ?? items[0]!;

  return (
    <section
      ref={ref}
      aria-roledescription="carousel"
      aria-label="What merchants say"
      className="relative isolate flex min-h-[640px] items-end overflow-hidden bg-[#2c3f2b] text-lime md:min-h-[720px] lg:h-[100svh] lg:max-h-[1000px] lg:min-h-[760px]"
    >
      <SmartImage
        src={assets["testimonial.jpg"]}
        alt=""
        fallback={fallbacks.testimonial}
        className="absolute inset-0 -z-20"
        imgClassName="object-[62%_center]"
      />
      {/* A progressive blur and a green wash rising from the bottom left */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 backdrop-blur-[26px] [mask-image:radial-gradient(95%_70%_at_0%_100%,#000_30%,transparent_72%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(100%_75%_at_0%_100%,rgba(30,58,34,0.78)_0%,rgba(36,64,38,0.42)_42%,rgba(36,64,38,0)_72%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-1/2 bg-[linear-gradient(0deg,rgba(24,40,24,0.45),rgba(24,40,24,0))]"
      />

      <div className="shell relative flex w-full flex-col gap-8 pb-10 pt-40 md:flex-row md:items-end md:justify-between lg:pb-16">
        <div className="flex min-h-[260px] max-w-[980px] flex-col justify-end md:min-h-[300px] lg:min-h-[330px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.figure
              key={index}
              className="flex h-full flex-col justify-end"
              exit={{ opacity: 0, filter: "blur(10px)", y: -10 }}
              transition={{ duration: 0.35, ease: EASE_REVEAL }}
            >
              <BlurWords
                as="span"
                text={item.name}
                play={inView}
                lineClassName=""
                className="block text-[18px] tracking-[-0.025em] text-lime lg:text-[clamp(18px,1.95vw,28px)]"
              />
              <blockquote className="mt-6 lg:mt-[62px]">
                <BlurLines
                  text={item.quote}
                  play={inView}
                  delay={0.3}
                  className="text-[28px] leading-[1.08] tracking-[-0.035em] text-lime md:text-[36px] lg:text-[clamp(36px,3.35vw,48px)]"
                />
              </blockquote>
            </motion.figure>
          </AnimatePresence>
        </div>

        <div
          className="flex shrink-0 items-center gap-2.5 md:pb-[70px]"
          onPointerEnter={() => setPaused(true)}
          onPointerLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <button
            type="button"
            onClick={prev}
            aria-label="Previous testimonial"
            className="grid h-12 w-12 place-items-center rounded-full bg-white/15 text-white/85 backdrop-blur-md transition-colors hover:bg-white/25"
          >
            <ArrowLeft size={17} />
          </button>
          <ProgressRing
            duration={intervalMs / 1000}
            running={autoplay && inView && !reduced && !paused}
            runKey={index}
            onComplete={autoNext}
            size={48}
            className="text-white/90"
          >
            <button
              type="button"
              onClick={next}
              aria-label="Next testimonial"
              className="grid h-12 w-12 place-items-center rounded-full bg-white/15 text-white/85 backdrop-blur-md transition-colors hover:bg-white/25"
            >
              <ArrowRight size={17} />
            </button>
          </ProgressRing>
        </div>
      </div>
    </section>
  );
}
