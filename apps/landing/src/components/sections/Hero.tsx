"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { useReduced } from "@/components/motion/hooks";
import { Button } from "@/components/ui/Button";
import { fallbacks } from "@/components/ui/fallbacks";
import { SmartImage } from "@/components/ui/SmartImage";
import { hero } from "@/content";
import type { Assets } from "@/lib/assets";
import { HeroCard } from "./HeroCard";

/**
 * 1. Hero: a full-bleed photo under a dark gradient, the headline at the
 * bottom left and the Payments card at the bottom right (the nav, HeroNav,
 * sits over it from outside <main>). The headline's words blur in with CSS,
 * so they play before hydration; the rest plays its load sequence once the
 * page has mounted. The photo moves at about 0.85x the scroll speed.
 */
export function Hero({ assets }: { assets: Assets }) {
  const sectionRef = useRef<HTMLElement>(null);
  const reduced = useReduced();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start start", "end start"] });
  // Over the section's own height of scrolling, the photo drifts down 15%
  // of that distance: it travels at 0.85x the page.
  const photoY = useTransform(scrollYProgress, [0, 1], ["0%", "15%"]);

  return (
    <section
      ref={sectionRef}
      id="top"
      aria-label="Introduction"
      className="relative isolate overflow-hidden bg-[#1b1912] text-white"
    >
      <motion.div className="absolute inset-0 -z-20 will-change-transform" style={{ y: reduced ? 0 : photoY }}>
        <SmartImage
          src={assets["hero.jpg"]}
          alt=""
          fallback={fallbacks.hero}
          priority
          className="h-full w-full"
          imgClassName="object-[64%_center] lg:object-center"
        />
      </motion.div>
      {/* Dark on the left and along the bottom, for the copy */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(14,12,8,0.62)_0%,rgba(14,12,8,0.32)_36%,rgba(14,12,8,0)_62%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(0deg,rgba(14,12,8,0.62)_0%,rgba(14,12,8,0.18)_34%,rgba(14,12,8,0)_55%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-40 bg-[linear-gradient(180deg,rgba(14,12,8,0.35),rgba(14,12,8,0))]"
      />

      <div className="relative flex min-h-[100svh] flex-col justify-end px-4 pb-8 pt-28 md:px-8 md:pb-10 lg:min-h-[max(720px,100svh)] lg:flex-row lg:items-end lg:justify-between lg:gap-10 lg:px-12 lg:pb-12">
        <div className="max-w-[820px]">
          <BlurWords as="h1" text={hero.headline} css delay={0.15} className="display text-hero text-white" />
          <BlurLines
            text={hero.sub}
            play={ready}
            delay={0.78}
            className="mt-5 max-w-[590px] text-[17px] leading-[1.25] tracking-[-0.02em] text-white/90 lg:mt-[22px] lg:text-[clamp(17px,1.5vw,22px)]"
          />
          <div className="mt-7 lg:mt-[40px]">
            <Button
              href={hero.cta.href}
              variant="lime"
              size="lg"
              arrow
              reveal={{ play: ready, delay: 1.1, from: "#2d3a02", textFrom: "#e1ff67" }}
            >
              {hero.cta.label}
            </Button>
          </div>
        </div>

        <HeroCard ready={ready} className="mt-10 shrink-0 lg:mt-0" />
      </div>
    </section>
  );
}
