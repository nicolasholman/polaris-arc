"use client";

import { motion, useReducedMotion } from "motion/react";
import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export type SuccessCheckProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** Diameter in px. */
  size?: number;
  /** `lime` (ref A's primary), `up` (green), `purple`. */
  tone?: "lime" | "up" | "purple";
  /** What happened, for screen readers ("Paid"). Decorative without it. */
  label?: string;
};

const TONES = {
  lime: { disc: "bg-ui-lime text-ui-on-lime", ring: "border-ui-lime" },
  up: { disc: "bg-ui-up text-[#0f1011]", ring: "border-ui-up" },
  purple: { disc: "bg-ui-purple text-white", ring: "border-ui-purple" },
};

const SPRING = { type: "spring", stiffness: 420, damping: 22, mass: 0.9 } as const;

/**
 * The success mark on a receipt: a disc that springs in, a ring that pulses
 * out once, and a check that draws itself. Still under reduced motion.
 *
 * ```tsx
 * <SuccessCheck label="Paid" />
 * ```
 */
export function SuccessCheck({ size = 88, tone = "lime", label, className, style, ...props }: SuccessCheckProps) {
  const reduced = useReducedMotion() ?? false;
  const t = TONES[tone];
  const stroke = Math.max(2.4, size / 30);
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      {reduced ? null : (
        <motion.span
          aria-hidden
          className={cn("absolute inset-0 rounded-full border-2", t.ring)}
          initial={{ scale: 0.7, opacity: 0.8 }}
          animate={{ scale: 1.55, opacity: 0 }}
          transition={{ duration: 0.9, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <motion.span
        aria-hidden
        className={cn("grid size-full place-items-center rounded-full", t.disc)}
        initial={reduced ? false : { scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={reduced ? { duration: 0 } : SPRING}
      >
        <svg viewBox="0 0 24 24" width={size * 0.46} height={size * 0.46} fill="none" aria-hidden>
          <motion.path
            d="M4.5 12.6 9.6 17.4 19.5 6.9"
            stroke="currentColor"
            strokeWidth={(stroke * 24) / (size * 0.46)}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={reduced ? { duration: 0 } : { duration: 0.42, delay: 0.22, ease: [0.65, 0, 0.35, 1] }}
          />
        </svg>
      </motion.span>
    </span>
  );
}
