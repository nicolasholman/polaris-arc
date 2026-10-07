"use client";

import { motion, type Variants } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@polaris/ui";
import { usePlay } from "./hooks";
import { CARD_RISE, EASE_REVEAL } from "./tokens";

const TAGS = {
  div: motion.div,
  li: motion.li,
  span: motion.span,
  section: motion.section,
  article: motion.article,
  footer: motion.footer,
} as const;

type Timing = { delay: number; duration: number };

const riseVariants: Variants = {
  hidden: ({ y, blur }: { y: number; blur: number }) => ({
    opacity: 0,
    y,
    filter: blur ? `blur(${blur}px)` : "blur(0px)",
  }),
  visible: ({ delay, duration }: Timing) => ({
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { delay, duration, ease: EASE_REVEAL },
  }),
};

export type RiseProps = {
  as?: keyof typeof TAGS;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  delay?: number;
  duration?: number;
  /** Distance travelled, px. Cards rise 40px. */
  y?: number;
  /** Optional blur at the start, px. */
  blur?: number;
  play?: boolean;
  amount?: number;
  id?: string;
};

/** Rise and fade in: cards rise 40px, staggered by the caller. */
export function Rise({
  as = "div",
  children,
  className,
  style,
  delay = 0,
  duration = 0.8,
  y = CARD_RISE,
  blur = 0,
  play,
  amount,
  id,
}: RiseProps) {
  const { ref, shown } = usePlay<HTMLElement>(play, amount);
  const Tag = TAGS[as] as typeof motion.div;
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      id={id}
      className={cn("rv", className)}
      style={style}
      variants={riseVariants}
      custom={{ delay, duration, y, blur }}
      initial="hidden"
      animate={shown ? "visible" : "hidden"}
    >
      {children}
    </Tag>
  );
}
