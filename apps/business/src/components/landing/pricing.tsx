"use client";

import { PrimaryButton } from "@polaris/ui";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Glass } from "@/components/app/glass";
import { BlurWords, Rise } from "@/components/motion";
import { pricing } from "./content";
import { Shell } from "./section";

/** Pricing in one line. */
export function Pricing() {
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-24 py-20 lg:py-28">
      <Shell>
        <div className="relative isolate overflow-hidden rounded-[32px] bg-ui-surface-1 px-6 py-14 ring-1 ring-ui-hairline-strong sm:px-12 lg:px-16 lg:py-20">
          {/* A crisp lime glass coin in the corner, whole and inside the card. */}
          <Glass art="coin-lime" size={200} className="absolute top-8 right-8 -z-10 hidden w-[132px] rotate-[14deg] opacity-90 md:block lg:top-10 lg:right-12 lg:w-[176px]" />
          <Rise y={10} blur={4} duration={0.6}>
            <p className="inline-flex items-center gap-2 text-[14px] font-medium tracking-[0.02em] text-ui-lime uppercase">
              <span aria-hidden className="size-1.5 rounded-full bg-ui-lime" />
              {pricing.eyebrow}
            </p>
          </Rise>
          <BlurWords
            id="pricing-title"
            as="h2"
            text={pricing.line}
            className="mt-4 text-[clamp(36px,5.2vw,76px)] leading-[1.02] font-medium tracking-[-0.045em] text-balance md:pr-[150px] lg:pr-[200px]"
          />
          <Rise y={14} delay={0.3} className="mt-6 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <p className="max-w-[560px] text-[17px] leading-[1.5] text-ui-muted lg:text-[19px]">{pricing.sub}</p>
            <div className="flex flex-col items-start gap-3 lg:items-end">
              <PrimaryButton asChild size="lg" iconRight={<ArrowRight />}>
                <Link href="/login">Start accepting payments</Link>
              </PrimaryButton>
              <p className="text-[14px] text-ui-muted">{pricing.compare}</p>
            </div>
          </Rise>
        </div>
      </Shell>
    </section>
  );
}
