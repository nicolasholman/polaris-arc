"use client";

import { Marquee, Rise } from "@/components/motion";
import { LOGO_SPEED } from "@/components/motion/tokens";
import { sponsors } from "./content";

/**
 * "Built on Monad with …": a pill over an endless row of the names, set as
 * plain wordmarks. No invented glyphs beside real names: they read as fake
 * logos.
 */
export function Sponsors() {
  return (
    <section aria-label="Built with" className="py-14 lg:py-20">
      <div className="flex flex-col items-center px-4">
        <Rise
          y={14}
          blur={6}
          duration={0.7}
          className="flex min-h-[40px] items-center rounded-full bg-ui-surface-1 px-5 text-center text-[14px] tracking-[-0.01em] text-ui-muted ring-1 ring-white/6 md:text-[16px]"
        >
          {sponsors.pill}
        </Rise>
      </div>
      <Rise y={0} duration={1} delay={0.15} className="mt-9 lg:mt-12">
        <Marquee
          speed={LOGO_SPEED}
          gap="clamp(40px, 4.9vw, 72px)"
          className="mx-auto max-w-[1280px] py-2 [mask-image:linear-gradient(90deg,transparent_0%,#000_12%,#000_88%,transparent_100%)]"
        >
          {sponsors.items.map((item) => (
            <span key={item.name} className="text-[24px] font-semibold tracking-[-0.04em] whitespace-nowrap text-ui-text/60 lg:text-[30px]">
              {item.name}
            </span>
          ))}
        </Marquee>
      </Rise>
    </section>
  );
}
