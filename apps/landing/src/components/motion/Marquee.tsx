"use client";

import { motion, useAnimationFrame, useInView, useMotionValue } from "motion/react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useIsomorphicLayoutEffect, useReduced } from "./hooks";
import { LOGO_SPEED } from "./tokens";

export type MarqueeProps = {
  children: ReactNode;
  /** px per second. */
  speed?: number;
  direction?: "left" | "right";
  /** Space between items and between copies: px, or any CSS length. */
  gap?: number | string;
  className?: string;
  trackClassName?: string;
  pauseOnHover?: boolean;
};

/**
 * An endless row. It repeats its children until the row is covered, moves at
 * a constant speed and eases to a stop while hovered. Frozen under reduced
 * motion, and idle while off screen.
 */
export function Marquee({
  children,
  speed = LOGO_SPEED,
  direction = "left",
  gap = 0,
  className,
  trackClassName,
  pauseOnHover = true,
}: MarqueeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const [copyWidth, setCopyWidth] = useState(0);
  const [copies, setCopies] = useState(2);
  const x = useMotionValue(0);
  const factor = useRef(1);
  const target = useRef(1);
  const reduced = useReduced();
  const inView = useInView(containerRef, { margin: "200px" });

  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const copy = copyRef.current;
      const container = containerRef.current;
      if (!copy || !container) return;
      const width = copy.offsetWidth;
      if (!width) return;
      setCopyWidth(width);
      setCopies(Math.max(2, Math.ceil(container.offsetWidth / width) + 1));
      if (direction === "right" && x.get() === 0) x.set(-width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (copyRef.current) observer.observe(copyRef.current);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [direction]);

  useAnimationFrame((_, delta) => {
    if (!copyWidth || reduced || !inView) return;
    const dt = Math.min(delta, 64) / 1000;
    factor.current += (target.current - factor.current) * Math.min(1, dt * 6);
    const step = speed * dt * factor.current * (direction === "left" ? -1 : 1);
    let next = x.get() + step;
    if (direction === "left" && next <= -copyWidth) next += copyWidth;
    if (direction === "right" && next >= 0) next -= copyWidth;
    x.set(next);
  });

  return (
    <div
      ref={containerRef}
      className={cn("overflow-hidden", className)}
      onPointerEnter={pauseOnHover ? () => (target.current = 0) : undefined}
      onPointerLeave={pauseOnHover ? () => (target.current = 1) : undefined}
    >
      <motion.div className={cn("flex w-max", trackClassName)} style={{ x }}>
        {Array.from({ length: copies }, (_, i) => (
          <div
            key={i}
            ref={i === 0 ? copyRef : undefined}
            className="flex shrink-0 items-center"
            style={{ gap, paddingRight: gap }}
            aria-hidden={i > 0 ? true : undefined}
          >
            {children}
          </div>
        ))}
      </motion.div>
    </div>
  );
}
