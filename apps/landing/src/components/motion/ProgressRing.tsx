"use client";

import { animate, motion, useMotionValue } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ProgressRingProps = {
  /** Seconds for one full turn (the autoplay interval). */
  duration: number;
  /** The ring draws while true and holds its place while false. */
  running: boolean;
  /** Changing it restarts the ring from zero. */
  runKey: string | number;
  onComplete?: () => void;
  size?: number;
  stroke?: number;
  className?: string;
  children?: ReactNode;
};

/**
 * A circle that draws itself around its children over `duration`, then calls
 * `onComplete`. Used on the testimonial's next button.
 */
export function ProgressRing({
  duration,
  running,
  runKey,
  onComplete,
  size = 48,
  stroke = 1.5,
  className,
  children,
}: ProgressRingProps) {
  const progress = useMotionValue(0);
  const done = useRef(onComplete);
  useEffect(() => {
    done.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    progress.set(0);
  }, [runKey, progress]);

  useEffect(() => {
    if (!running) return;
    const remaining = Math.max(0.01, (1 - progress.get()) * duration);
    const controls = animate(progress, 1, {
      duration: remaining,
      ease: "linear",
      onComplete: () => done.current?.(),
    });
    return () => controls.stop();
  }, [running, runKey, duration, progress]);

  const r = (size - stroke) / 2;
  return (
    <span className={cn("relative inline-grid place-items-center", className)} style={{ width: size, height: size }}>
      {children}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -rotate-90"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          style={{ pathLength: progress }}
        />
      </svg>
    </span>
  );
}
