"use client";

import { motion } from "motion/react";
import { useState, type CSSProperties } from "react";
import { BlurWords } from "@/components/motion/BlurWords";
import { useReduced } from "@/components/motion/hooks";
import { EASE_REVEAL } from "@/components/motion/tokens";
import { GridDots } from "@/components/ui/icons";
import { hero } from "@/content";
import { cn } from "@/lib/cn";

type Tab = (typeof hero.card.tabs)[number];

const CARD_HEIGHT = 312;
const TONES = ["bg-olive-mid", "bg-olive", "bg-lime-bar"] as const;
/** Grow order inside a column: the olive block first, then the others. */
const ORDER = [1, 0, 2] as const;

/**
 * The floating "Payments" card at the bottom right of the hero. On load it
 * grows up from a thin pill, its title blurs in, the badge pops to olive and
 * the bars grow from zero height on a staggered spring. The tabs switch data
 * sets and the bars glide to their new heights.
 */
export function HeroCard({ ready, className }: { ready: boolean; className?: string }) {
  const reduced = useReduced();
  const go = ready || reduced;
  const [tab, setTab] = useState<Tab>("Weekly");
  const series = hero.card.series[tab];

  return (
    <div className={cn("relative w-full max-w-[360px] lg:w-[302px] lg:max-w-none", className)}>
      {/* The thin scroll indicator to the card's left */}
      <motion.div
        aria-hidden="true"
        className="rv absolute -left-[20px] top-[37px] hidden h-[177px] w-[4px] origin-top overflow-hidden rounded-full bg-white/25 backdrop-blur-sm lg:block"
        initial={{ opacity: 0, scaleY: 0.4 }}
        animate={go ? { opacity: 1, scaleY: 1 } : undefined}
        transition={{ delay: 1.15, duration: 0.7, ease: EASE_REVEAL }}
      >
        <motion.div
          className="h-[28px] w-full rounded-full bg-white"
          animate={reduced ? undefined : { y: [0, 6, 0] }}
          transition={{ delay: 2, duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>

      <div className="relative" style={{ height: CARD_HEIGHT }}>
        <motion.div
          className="rv rv-h absolute inset-x-0 bottom-0 overflow-hidden rounded-[22px] bg-white text-olive shadow-[0_30px_70px_-30px_rgba(0,0,0,0.55)]"
          style={{ "--rv-h": `${CARD_HEIGHT}px` } as CSSProperties}
          initial={{ height: 28, opacity: 0 }}
          animate={go ? { height: CARD_HEIGHT, opacity: 1 } : undefined}
          transition={{
            height: { delay: 0.05, duration: 1.15, ease: EASE_REVEAL },
            opacity: { delay: 0.05, duration: 0.3 },
          }}
        >
          <div className="absolute inset-x-0 top-0 px-6 pt-[22px]" style={{ height: CARD_HEIGHT }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <BlurWords
                  as="p"
                  text={hero.card.title}
                  play={go}
                  delay={0.3}
                  lineClassName=""
                  className="text-[25px] font-medium leading-none tracking-[-0.04em]"
                />
                {/* In the video the badge turns olive while the bars are
                    still thin lines, so it pops before they grow. */}
                <motion.span
                  className="rv rv-fill inline-flex h-[24px] items-center rounded-full px-[9px] text-[13px] font-medium tracking-[-0.01em]"
                  style={{ "--rv-bg": "#2d3a02", "--rv-fg": "#e1ff67" } as CSSProperties}
                  initial={{ opacity: 0, scale: 0.6, backgroundColor: "#d9dccb", color: "#ffffff" }}
                  animate={
                    go
                      ? {
                          opacity: 1,
                          scale: [0.6, 1, 1, 1.2, 1],
                          backgroundColor: ["#d9dccb", "#d9dccb", "#d9dccb", "#2d3a02", "#2d3a02"],
                          color: ["#ffffff", "#ffffff", "#ffffff", "#e1ff67", "#e1ff67"],
                        }
                      : undefined
                  }
                  transition={{
                    delay: 0.35,
                    duration: 0.8,
                    times: [0, 0.2, 0.55, 0.75, 1],
                    opacity: { delay: 0.35, duration: 0.25 },
                  }}
                >
                  {hero.card.badge}
                </motion.span>
              </div>
              <GridDots className="text-[#dcddd5]" />
            </div>

            <div role="group" aria-label="Payments period" className="mt-[14px] flex gap-4 text-[14px] tracking-[-0.02em]">
              {hero.card.tabs.map((name, i) => (
                <motion.button
                  key={name}
                  type="button"
                  aria-pressed={tab === name}
                  onClick={() => setTab(name)}
                  className={cn(
                    // A 24px target; the negative margin keeps the row where it was.
                    "reveal-word -mx-0.5 -my-[5px] min-h-6 px-0.5 py-[5px] transition-colors",
                    tab === name ? "font-medium text-olive" : "text-muted hover:text-olive/70",
                  )}
                  initial={{ opacity: 0, filter: "blur(8px)", y: 4 }}
                  animate={go ? { opacity: 1, filter: "blur(0px)", y: 0 } : undefined}
                  transition={{ delay: 0.55 + i * 0.09, duration: 0.6, ease: EASE_REVEAL }}
                >
                  {name}
                </motion.button>
              ))}
            </div>

            {/* The stacked chart */}
            <div className="absolute inset-x-6 top-[140px] flex h-[136px] justify-between" aria-hidden="true">
              {series.map((column, c) => (
                <motion.div
                  key={c}
                  className="flex w-[56px] flex-col"
                  animate={{ paddingTop: column.top }}
                  initial={false}
                  transition={{ type: "spring", stiffness: 170, damping: 22 }}
                >
                  {column.h.map((h, b) => (
                    <motion.div
                      key={b}
                      className={cn("rv w-full rounded-[5px]", TONES[b])}
                      initial={{ scaleY: 0, height: h, marginTop: b === 0 ? 0 : column.gap }}
                      animate={
                        go
                          ? { scaleY: 1, height: h, marginTop: b === 0 ? 0 : column.gap }
                          : undefined
                      }
                      transition={{
                        scaleY: {
                          delay: 0.72 + c * 0.1 + (ORDER[b] ?? b) * 0.07,
                          type: "spring",
                          stiffness: 260,
                          damping: 15,
                          mass: 0.9,
                        },
                        height: { type: "spring", stiffness: 170, damping: 22 },
                        marginTop: { type: "spring", stiffness: 170, damping: 22 },
                      }}
                    />
                  ))}
                </motion.div>
              ))}
            </div>

            <BlurWords
              as="p"
              text={hero.card.caption}
              play={go}
              delay={1.3}
              stagger={0.05}
              lineClassName=""
              className="absolute bottom-[22px] left-6 text-[13px] tracking-[-0.01em] text-muted"
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
