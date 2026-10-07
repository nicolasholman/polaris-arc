"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { usePlay } from "./hooks";
import { EASE_REVEAL } from "./tokens";

export type DrawLineProps = {
  className?: string;
  delay?: number;
  duration?: number;
  play?: boolean;
  /** Draw from the left (default) or grow from the top, for vertical rules. */
  axis?: "x" | "y";
};

/** A hairline that draws itself in. */
export function DrawLine({ className, delay = 0, duration = 0.9, play, axis = "x" }: DrawLineProps) {
  const { ref, shown } = usePlay<HTMLDivElement>(play);
  const from = axis === "x" ? { scaleX: 0 } : { scaleY: 0 };
  const to = axis === "x" ? { scaleX: 1 } : { scaleY: 1 };
  return (
    <motion.div
      ref={ref}
      aria-hidden="true"
      className={cn("rv", axis === "x" ? "origin-left" : "origin-top", className)}
      initial={from}
      animate={shown ? to : from}
      transition={{ delay, duration, ease: EASE_REVEAL }}
    />
  );
}
