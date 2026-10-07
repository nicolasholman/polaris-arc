"use client";

import { motion, type Variants } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useIsomorphicLayoutEffect, useReduced, useVisibleOnce } from "./hooks";
import { EASE_REVEAL } from "./tokens";

type Custom = {
  from: number;
  y: number;
  delay: number;
  duration: number;
};

/*
 * The card animates one number, --g: the share of its height still hidden
 * above the top edge (1 - from at the start, 0 at the end). The clip-path
 * reads it, and so does every GrowAnchor inside, which is how top-anchored
 * content rides up with the edge.
 */
const growVariants: Variants = {
  hidden: ({ from, y }: Custom) => ({
    "--g": 1 - from,
    y,
    opacity: 0,
  }),
  visible: ({ delay, duration }: Custom) => ({
    "--g": 0,
    y: 0,
    opacity: 1,
    transition: {
      delay,
      duration,
      ease: EASE_REVEAL,
      opacity: { delay, duration: 0.35, ease: "easeOut" },
    },
  }),
};

export type GrowProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Visible share of the height at the start (0..1). The card grows up from its bottom edge. */
  from?: number;
  radius?: number;
  /** Optionally it also rises this far while growing, px (the credit row). */
  y?: number;
  delay?: number;
  duration?: number;
  play?: boolean;
  amount?: number;
  id?: string;
};

/**
 * A card that grows from a shorter height with its bottom edge fixed, as in
 * the reference: only the top edge moves. The growth is a clip-path, so
 * layout never moves. Content that belongs to the top of the card (a photo,
 * a doodle, a title) goes in a GrowAnchor so it travels with that edge;
 * content anchored to the bottom stays put.
 */
export function Grow({
  children,
  className,
  style,
  from = 0.45,
  radius = 22,
  y = 0,
  delay = 0,
  duration = 1,
  play,
  amount,
  id,
}: GrowProps) {
  const [ref, visible] = useVisibleOnce<HTMLDivElement>(amount);
  const reduced = useReduced();
  const shown = reduced || (play ?? visible);

  // Anchors translate by --g times the card's height, published as --gh.
  // Until it is measured (or without JS) they sit at their final place.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => el.style.setProperty("--gh", `${el.offsetHeight}px`);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      ref={ref}
      id={id}
      className={cn("rv", className)}
      style={{ ...style, clipPath: `inset(calc(var(--g, 0) * 100%) 0 0 0 round ${radius}px)` }}
      variants={growVariants}
      custom={{ from, y, delay, duration } satisfies Custom}
      initial="hidden"
      animate={shown ? "visible" : "hidden"}
    >
      {children}
    </motion.div>
  );
}

/**
 * Content pinned to a Grow card's top edge: it starts pushed down by the
 * hidden share of the card and rides up with the edge as the card grows.
 * Under reduced motion or without JS (.rv) it simply sits in place.
 */
export function GrowAnchor({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={cn("rv", className)} style={{ transform: "translateY(calc(var(--g, 0) * var(--gh, 0px)))" }}>
      {children}
    </div>
  );
}
