"use client";

import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { DrawLine } from "@/components/motion/DrawLine";
import { useReveal } from "@/components/motion/hooks";
import { Pop } from "@/components/motion/Pop";
import { Rise } from "@/components/motion/Rise";
import { Button } from "@/components/ui/Button";
import { fallbacks } from "@/components/ui/fallbacks";
import { SmartImage } from "@/components/ui/SmartImage";
import { talk } from "@/content";
import type { Assets } from "@/lib/assets";

const AVATARS = ["avatar-1.jpg", "avatar-2.jpg", "avatar-3.jpg"] as const;

/**
 * 9. "Talk to the team": centred on the white-to-lime gradient. The heading
 * and paragraph blur in, then "Builders", the avatars pop in one by one, the
 * 3+ bubble, a divider and the "Book a demo" button.
 */
export function Talk({ assets }: { assets: Assets }) {
  const [rowRef, rowInView] = useReveal<HTMLDivElement>(0.5);
  return (
    <section id="talk" aria-labelledby="talk-heading" className="pt-24 md:pt-28 lg:pt-[117px]">
      <div className="shell flex flex-col items-center text-center">
        <BlurWords id="talk-heading" as="h2" text={talk.heading} className="heading text-h2 text-olive" />
        <BlurLines
          text={talk.body}
          delay={0.25}
          className="mt-5 max-w-[570px] text-balance text-[17px] leading-[1.2] tracking-[-0.025em] text-olive/90 lg:mt-[26px] lg:text-[clamp(17px,1.39vw,20px)]"
        />
        <div ref={rowRef} className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-5 lg:mt-[30px]">
          <div className="flex items-center gap-3">
            <Rise as="span" y={8} blur={6} play={rowInView} delay={0.1} className="text-[18px] tracking-[-0.025em] text-olive lg:text-[20px]">
              {talk.label}
            </Rise>
            <div className="flex items-center">
              {AVATARS.map((file, i) => (
                <Pop key={file} play={rowInView} delay={0.25 + i * 0.12} className="-ml-2.5 block first:ml-0">
                  <SmartImage
                    src={assets[file]}
                    alt=""
                    fallback={fallbacks.avatars[i] ?? fallbacks.avatars[0]}
                    className="h-[40px] w-[40px] rounded-full border-2 border-[#f3fdca]"
                  />
                </Pop>
              ))}
              <Pop play={rowInView} delay={0.25 + AVATARS.length * 0.12} className="-ml-2.5 block">
                <span className="grid h-[40px] w-[40px] place-items-center rounded-full border-2 border-[#f3fdca] bg-olive text-[12px] font-medium text-white">
                  {talk.more}
                </span>
              </Pop>
            </div>
          </div>
          <DrawLine axis="y" play={rowInView} delay={0.8} className="hidden h-[22px] w-px bg-olive/30 sm:block" />
          <Button href={talk.cta.href} size="lg" arrow reveal={{ play: rowInView, delay: 0.85 }}>
            {talk.cta.label}
          </Button>
        </div>
      </div>
    </section>
  );
}
