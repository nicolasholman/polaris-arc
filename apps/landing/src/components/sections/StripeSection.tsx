"use client";

import { motion } from "motion/react";
import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { Grow, GrowAnchor } from "@/components/motion/Grow";
import { usePlay } from "@/components/motion/hooks";
import { Rise } from "@/components/motion/Rise";
import { CARD_STAGGER, EASE_REVEAL } from "@/components/motion/tokens";
import { Button } from "@/components/ui/Button";
import { FlowerDoodle } from "@/components/ui/Doodles";
import { fallbacks } from "@/components/ui/fallbacks";
import { FlagEU, FlagUK, FlagUS } from "@/components/ui/Flags";
import { ArrowSmall, PlusIcon } from "@/components/ui/icons";
import { SmartImage } from "@/components/ui/SmartImage";
import { stripe } from "@/content";
import type { Assets } from "@/lib/assets";

const AVATARS = ["avatar-1.jpg", "avatar-2.jpg", "avatar-3.jpg"] as const;

/**
 * 3. "Stripe for every app on Monad": the heading, two buttons and two
 * two-tone paragraphs on the left; the mint card and the dark olive card on
 * the right, bottom-aligned. The cards grow up from a shorter height; the
 * frosted panels slide in from beyond the dark card's right edge.
 */
export function StripeSection({ assets }: { assets: Assets }) {
  return (
    <section id="product" aria-labelledby="stripe-heading" className="pt-24 md:pt-32 lg:pt-[133px]">
      <div className="shell grid gap-12 md:grid-cols-2 md:gap-x-[18px] md:gap-y-14 xl:grid-cols-[minmax(0,560fr)_minmax(0,391fr)_minmax(0,341fr)] xl:items-end xl:gap-y-0">
        <div className="md:col-span-2 xl:col-span-1 xl:pr-8">
          <BlurWords id="stripe-heading" as="h2" text={stripe.heading} className="heading text-h2 text-olive" />
          <Rise y={16} delay={0.35} className="mt-8 flex flex-wrap gap-2.5 lg:mt-[44px]">
            <Button href={stripe.primary.href} arrow reveal={{ delay: 0.4 }}>
              {stripe.primary.label}
            </Button>
            <Button href={stripe.secondary.href} variant="outline">
              {stripe.secondary.label}
            </Button>
          </Rise>
          <div className="mt-10 max-w-[560px] space-y-[18px] text-[17px] leading-[1.3] tracking-[-0.02em] lg:mt-[56px] lg:text-[clamp(17px,1.39vw,20px)]">
            {stripe.paragraphs.map((p, i) => (
              <BlurLines
                key={i}
                delay={0.2 + i * 0.16}
                text={[
                  { text: p.lead, className: "text-olive" },
                  { text: p.rest, className: "text-muted" },
                ]}
              />
            ))}
          </div>
        </div>

        <MintCard />
        <DarkCard assets={assets} />
      </div>
    </section>
  );
}

function MintCard() {
  const { mint } = stripe;
  return (
    <Grow
      from={0.3}
      delay={0}
      duration={1.1}
      className="flex min-h-[280px] flex-col rounded-card bg-mint px-7 pb-6 pt-[30px] md:h-[370px] xl:h-[280px]"
    >
      {/* The title rides up with the card's top edge */}
      <GrowAnchor>
        <BlurWords
          as="h3"
          text={mint.title}
          delay={0.3}
          className="text-[26px] font-medium leading-[1.17] tracking-[-0.035em] text-olive xl:text-[clamp(24px,2.1vw,30px)]"
        />
      </GrowAnchor>
      <ul className="mt-auto space-y-[7px] pt-8 text-[14px] tracking-[-0.01em] text-olive/75">
        {mint.bullets.map((b, i) => (
          <Rise as="li" key={b} y={10} blur={6} delay={0.55 + i * 0.1} className="flex items-center gap-2.5">
            <ArrowSmall className="shrink-0 text-olive/45" />
            {b}
          </Rise>
        ))}
      </ul>
      <div className="mt-[18px]">
        <Button href={mint.cta.href} size="md" arrow reveal={{ delay: 0.8 }}>
          {mint.cta.label}
        </Button>
      </div>
    </Grow>
  );
}

function DarkCard({ assets }: { assets: Assets }) {
  const { dark } = stripe;
  const { ref, shown } = usePlay<HTMLDivElement>(undefined, 0.3);

  return (
    <Grow
      from={0.62}
      delay={CARD_STAGGER}
      duration={1.1}
      className="relative h-[370px] overflow-hidden rounded-card bg-olive-ink"
    >
      <div ref={ref} className="absolute inset-0">
        {/* The doodle and the panels belong to the top: they ride up with the edge */}
        <GrowAnchor className="absolute inset-0">
          <motion.div
            aria-hidden="true"
            className="rv absolute -left-[74px] -top-[86px] w-[270px] text-[#262e0c]"
            initial={{ opacity: 0, rotate: -20, scale: 0.9 }}
            animate={shown ? { opacity: 1, rotate: 0, scale: 1 } : undefined}
            transition={{ delay: 0.25, duration: 1.4, ease: EASE_REVEAL }}
          >
            <FlowerDoodle className="h-auto w-full" />
          </motion.div>

          {/* Send money: frosted sage panel */}
          <motion.div
            className="rv absolute left-[8.8%] top-[68px] w-[min(180px,56%)] rounded-[16px] bg-sage-panel/90 p-[11px] shadow-[0_18px_40px_-18px_rgba(0,0,0,0.6)] backdrop-blur-md"
            initial={{ x: 420, opacity: 0.6 }}
            animate={shown ? { x: 0, opacity: 1 } : undefined}
            transition={{ delay: 0.45, duration: 1.05, ease: EASE_REVEAL }}
          >
            <span className="inline-flex h-[30px] items-center rounded-full bg-white px-3 text-[13px] tracking-[-0.02em] text-olive">
              {dark.send}
            </span>
            <div className="mt-[14px] flex items-center">
              {AVATARS.map((file, i) => (
                <SmartImage
                  key={file}
                  src={assets[file]}
                  alt=""
                  fallback={fallbacks.avatars[i] ?? fallbacks.avatars[0]}
                  className="-ml-2 h-[38px] w-[38px] rounded-full border-2 border-sage-panel first:ml-0"
                />
              ))}
              <span className="-ml-1 grid h-[38px] w-[38px] place-items-center rounded-full border-2 border-sage-panel bg-white text-olive/70">
                <PlusIcon size={16} />
              </span>
            </div>
          </motion.div>

          {/* Across borders: outlined lime panel, clipped by the card edge */}
          <motion.div
            className="rv absolute left-[64.8%] top-[94px] w-[180px] rounded-[16px] border border-lime/55 bg-[rgba(34,42,6,0.72)] p-[11px] backdrop-blur-md"
            initial={{ x: 360, opacity: 0.6 }}
            animate={shown ? { x: 0, opacity: 1 } : undefined}
            transition={{ delay: 0.8, duration: 1.05, ease: EASE_REVEAL }}
          >
            <span className="inline-flex h-[28px] items-center rounded-full bg-lime px-3 text-[13px] tracking-[-0.02em] text-olive">
              {dark.borders}
            </span>
            <div className="mt-[14px] flex items-center">
              <FlagUK />
              <FlagEU className="-ml-2.5" />
              <FlagUS className="-ml-2.5" />
            </div>
          </motion.div>
        </GrowAnchor>

        <BlurWords
          as="h3"
          text={dark.title}
          delay={0.55}
          className="absolute bottom-[28px] left-[30px] right-[30px] text-[26px] font-medium leading-[1.1] tracking-[-0.035em] text-lime xl:text-[clamp(24px,2.1vw,30px)]"
        />
      </div>
    </Grow>
  );
}
