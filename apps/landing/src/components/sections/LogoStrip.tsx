"use client";

import { Marquee } from "@/components/motion/Marquee";
import { Rise } from "@/components/motion/Rise";
import { LOGO_SPEED } from "@/components/motion/tokens";
import { Wordmark } from "@/components/ui/Wordmarks";
import { logos } from "@/content";

/**
 * 2. Logo strip: a grey pill over an endless, left-scrolling row of
 * wordmarks (about 40px/s, pauses on hover) with faded edges.
 */
export function LogoStrip() {
  return (
    <section aria-label="Built with" className="pt-14 md:pt-20 lg:pt-[100px]">
      <div className="shell flex flex-col items-center">
        <Rise
          y={14}
          blur={6}
          duration={0.7}
          className="flex min-h-[38px] items-center rounded-full bg-pill px-4 text-center text-[14px] tracking-[-0.02em] text-olive md:text-[16px] lg:h-[44px] lg:px-[26px] lg:text-[21px]"
        >
          {logos.pill}
        </Rise>
      </div>
      <Rise y={0} duration={1} delay={0.15} className="mt-9 lg:mt-[58px]">
        <Marquee
          speed={LOGO_SPEED}
          gap="clamp(40px, 4.9vw, 70px)"
          className="mx-auto max-w-[calc(var(--content)+var(--gutter)*2)] py-2 [mask-image:linear-gradient(90deg,transparent_0%,#000_12%,#000_88%,transparent_100%)]"
        >
          {logos.items.map((item) => (
            <Wordmark key={item.name} name={item.name} glyph={item.glyph} />
          ))}
        </Marquee>
      </Rise>
    </section>
  );
}
