"use client";

import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useEffect } from "react";
import { useReduced } from "./hooks";

/** ease-out for counters */
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * A motion value that counts from `from` to `to` once `play` turns true
 * (1.2s, ease-out). Other elements can follow it, e.g. a bar that fills in
 * step with the number.
 */
export function useCountUp(
  to: number,
  play: boolean,
  { duration = 1.2, from = 0, delay = 0 }: { duration?: number; from?: number; delay?: number } = {},
): MotionValue<number> {
  const reduced = useReduced();
  const value = useMotionValue(from);

  useEffect(() => {
    if (reduced) {
      value.set(to);
      return;
    }
    if (!play) return;
    const controls = animate(value, to, { duration, delay, ease: EASE_OUT });
    return () => controls.stop();
  }, [play, to, reduced, duration, delay, value]);

  return value;
}

export type CountUpProps = {
  value: number;
  play: boolean;
  format: (n: number) => string;
  duration?: number;
  delay?: number;
  from?: number;
  className?: string;
};

/** A number that counts up when shown. */
export function CountUp({ value, play, format, duration, delay, from, className }: CountUpProps) {
  const mv = useCountUp(value, play, { duration, delay, from });
  const text = useTransform(mv, format);
  return (
    <span className={className}>
      <span className="sr-only">{format(value)}</span>
      <motion.span aria-hidden="true">{text}</motion.span>
    </span>
  );
}
