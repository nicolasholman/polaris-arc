"use client";

import { motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { usePlay } from "./hooks";

export type PopProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  delay?: number;
  play?: boolean;
  /** Starting scale. */
  from?: number;
};

/** Scales in on a spring with a small overshoot: avatars, badges, bubbles. */
export function Pop({ children, className, style, delay = 0, play, from = 0.3 }: PopProps) {
  const { ref, shown } = usePlay<HTMLSpanElement>(play);
  return (
    <motion.span
      ref={ref}
      className={cn("rv", className)}
      style={style}
      initial={{ scale: from, opacity: 0 }}
      animate={shown ? { scale: 1, opacity: 1 } : { scale: from, opacity: 0 }}
      transition={{
        delay,
        scale: { delay, type: "spring", stiffness: 420, damping: 18, mass: 0.8 },
        opacity: { delay, duration: 0.25 },
      }}
    >
      {children}
    </motion.span>
  );
}
