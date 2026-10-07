"use client";

import { motion, useTransform } from "motion/react";
import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { useCountUp } from "@/components/motion/CountUp";
import { Grow, GrowAnchor } from "@/components/motion/Grow";
import { useReveal } from "@/components/motion/hooks";
import { Marquee } from "@/components/motion/Marquee";
import { Rise } from "@/components/motion/Rise";
import { CARD_RISE, CARD_STAGGER, CHIP_SPEED } from "@/components/motion/tokens";
import { Button } from "@/components/ui/Button";
import { fallbacks } from "@/components/ui/fallbacks";
import { SmartImage } from "@/components/ui/SmartImage";
import { Streaks } from "@/components/ui/Streaks";
import { credit } from "@/content";
import type { Assets } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/format";

const CHIP_TONES = {
  olive: "bg-olive text-white",
  pale: "bg-lime-pale text-olive",
  lime: "bg-lime text-olive",
  grey: "bg-[#e6e6e2] text-olive",
  mint: "bg-mint-chip text-olive",
} as const;

type ChipTone = keyof typeof CHIP_TONES;
const ROW_A_TONES: ChipTone[] = ["pale", "olive", "pale", "lime"];
const ROW_B_TONES: ChipTone[] = ["lime", "grey", "mint", "olive", "grey"];

/**
 * 4. "Credit that feels like cash, fast": the heading with an outline pill,
 * then three cards that grow up and rise 40px, 120ms apart: the chip rows on
 * the green streaks, the credit line that counts up, and the photo card.
 * What sits at the top of each card rides up with its top edge.
 */
export function CreditSection({ assets }: { assets: Assets }) {
  return (
    <section aria-labelledby="credit-heading" className="pt-28 md:pt-36 lg:pt-[180px]">
      <div className="shell">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <BlurWords
            id="credit-heading"
            as="h2"
            text={credit.heading}
            lineClassName=""
            className="heading text-h2 max-w-[1100px] text-olive"
          />
          <Rise y={12} delay={0.4} className="shrink-0">
            <Button href={credit.cta.href} variant="outline" size="sm" arrow>
              {credit.cta.label}
            </Button>
          </Rise>
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:mt-[62px] xl:grid-cols-[minmax(0,381fr)_minmax(0,381fr)_minmax(0,556fr)]">
          <ChipsCard assets={assets} />
          <CreditLineCard />
          <PhotoCard assets={assets} />
        </div>
      </div>
    </section>
  );
}

const CARD = "relative h-[443px] overflow-hidden rounded-card";

function Chip({ label, tone }: { label: string; tone: ChipTone }) {
  return (
    <span
      className={cn(
        "inline-flex h-[40px] items-center whitespace-nowrap rounded-full px-[18px] text-[16px] tracking-[-0.02em]",
        CHIP_TONES[tone],
      )}
    >
      {label}
    </span>
  );
}

function ChipsCard({ assets }: { assets: Assets }) {
  const { chips } = credit;
  return (
    <Grow from={0.55} delay={0} y={CARD_RISE} className={CARD}>
      <GrowAnchor className="absolute inset-0">
        <Streaks image={assets["streaks.jpg"]} video={assets["streaks.mp4"]} />
      </GrowAnchor>
      <Rise
        y={90}
        delay={0.3}
        duration={1}
        className="absolute inset-x-[clamp(20px,2.8vw,40px)] top-[66px] flex h-[312px] flex-col overflow-hidden rounded-[18px] bg-white pb-[28px] pt-[30px] shadow-[0_20px_50px_-30px_rgba(30,60,10,0.5)]"
      >
        <BlurWords
          as="h3"
          text={chips.title}
          delay={0.5}
          lineClassName=""
          className="px-[30px] text-[26px] font-medium leading-[1.15] tracking-[-0.035em] text-olive"
        />
        <div className="mt-[40px] space-y-2">
          <Marquee speed={CHIP_SPEED} direction="right" gap={8}>
            {chips.rowA.map((label, i) => (
              <Chip key={`${label}-${i}`} label={label} tone={ROW_A_TONES[i % ROW_A_TONES.length] ?? "pale"} />
            ))}
          </Marquee>
          <Marquee speed={CHIP_SPEED} direction="left" gap={8}>
            {chips.rowB.map((label, i) => (
              <Chip key={`${label}-${i}`} label={label} tone={ROW_B_TONES[i % ROW_B_TONES.length] ?? "grey"} />
            ))}
          </Marquee>
        </div>
        <BlurLines
          text={chips.note}
          delay={0.75}
          className="mt-auto px-[30px] text-[15px] leading-[1.4] tracking-[-0.01em] text-muted"
        />
      </Rise>
    </Grow>
  );
}

const SEGMENT_TONES = { olive: "bg-olive", sage: "bg-sage", stone: "bg-stone" } as const;
const LEGEND_TONES = { olive: "bg-olive", sage: "bg-sage", stone: "bg-[#c9cabd]" } as const;

function CreditLineCard() {
  const { line } = credit;
  const [ref, inView] = useReveal<HTMLDivElement>(0.4);
  const value = useCountUp(line.amount, inView, { duration: 1.2, delay: 0.55 });
  const label = useTransform(value, (v) => formatUsd(v));
  // The bar fills in step with the number: its segments sit at their final
  // widths and the whole row scales out from the left, so each one grows to
  // its share of the progress, and CSS alone can show the end state.
  const fill = useTransform(value, (v) => v / line.amount);

  return (
    <Grow
      from={0.5}
      delay={CARD_STAGGER}
      y={CARD_RISE}
      className={cn(CARD, "flex flex-col bg-lavender px-[30px] pb-[30px] pt-[34px]")}
    >
      <GrowAnchor>
        <BlurWords
          as="h3"
          text={line.title}
          delay={0.3}
          className="text-[40px] font-medium leading-[1] tracking-[-0.045em] text-olive xl:text-[clamp(38px,3.4vw,49px)]"
        />
      </GrowAnchor>
      <Rise y={70} delay={0.4} duration={0.95} className="mt-auto">
        <div ref={ref} className="flex h-[250px] flex-col rounded-[18px] bg-white px-[25px] pb-6 pt-[22px] text-olive">
          <p className="text-[13px] tracking-[-0.01em]">{line.label}</p>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-[38px] font-medium leading-none tracking-[-0.045em]">
              <span className="sr-only">{formatUsd(line.amount)}</span>
              <motion.span aria-hidden="true" className="nojs-hide">
                {label}
              </motion.span>
              {/* Without JS nothing counts, so the amount shows as it is */}
              <span aria-hidden="true" className="nojs-show hidden">
                {formatUsd(line.amount)}
              </span>
            </span>
            <span className="text-[13px] tracking-[-0.01em]">{line.of}</span>
          </div>
          <dl className="mt-6 grid max-w-[260px] grid-cols-3 gap-2">
            {line.legend.map((item, i) => (
              <Rise key={item.label} y={8} delay={0.7 + i * 0.08} play={inView} className="text-[12px] tracking-[-0.01em]">
                <dt className="flex items-center gap-1.5">
                  <span aria-hidden="true" className={cn("h-[6px] w-[6px]", LEGEND_TONES[item.tone])} />
                  {item.label}
                </dt>
                <dd className="mt-1 pl-[12px] text-muted">{item.value}%</dd>
              </Rise>
            ))}
          </dl>
          <div className="mb-4 mt-auto h-[12px] w-[82%] overflow-hidden bg-[#f1f2ec]" aria-hidden="true">
            <motion.div className="rv flex h-full w-full origin-left" style={{ scaleX: fill }}>
              {line.legend.map((item) => (
                <span
                  key={item.label}
                  className={cn("h-full", SEGMENT_TONES[item.tone])}
                  style={{ width: `${item.value}%` }}
                />
              ))}
            </motion.div>
          </div>
        </div>
      </Rise>
    </Grow>
  );
}

function PhotoCard({ assets }: { assets: Assets }) {
  const { photo } = credit;
  return (
    <Grow from={0.5} delay={CARD_STAGGER * 2} y={CARD_RISE} className={cn(CARD, "md:col-span-2 xl:col-span-1")}>
      {/* The photo and the title ride up with the top edge */}
      <GrowAnchor className="absolute inset-0">
        <SmartImage
          src={assets["phone.jpg"]}
          alt="A person smiling at their phone"
          fallback={fallbacks.phone}
          className="absolute inset-0"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(20,18,12,0.62)_0%,rgba(20,18,12,0.28)_26%,rgba(20,18,12,0)_44%,rgba(20,18,12,0)_52%,rgba(20,18,12,0.55)_100%)]"
        />
        <BlurWords
          as="h3"
          text={photo.title}
          delay={0.45}
          lineClassName=""
          className="absolute left-[30px] right-[30px] top-[26px] text-balance text-[40px] font-medium leading-[1] tracking-[-0.045em] text-white xl:text-[clamp(40px,3.9vw,56px)]"
        />
      </GrowAnchor>
      <BlurLines
        text={photo.body}
        delay={0.65}
        className="absolute bottom-[26px] left-[30px] right-[30px] max-w-[500px] text-[22px] leading-[1.1] tracking-[-0.03em] text-white xl:text-[clamp(22px,2.1vw,30px)]"
      />
    </Grow>
  );
}
