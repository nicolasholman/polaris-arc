/**
 * The landing page's motion primitives, from apps/landing (same tokens, same
 * reveal-on-scroll, the same Lenis setup), so the merchant landing moves like
 * the consumer one. Every primitive shows its final state under reduced motion.
 *
 * A copy: apps/landing/src/components/motion has the same files (plus a few
 * the landing alone uses). Change one, change the other, or move both into
 * packages/ui. hooks.ts is identical in both.
 */
export { BlurWords } from "./BlurWords";
export { BlurLines, type Segment } from "./BlurLines";
export { Rise } from "./Rise";
export { Marquee } from "./Marquee";
export { CountUp, useCountUp } from "./CountUp";
export { DrawLine } from "./DrawLine";
export { SmoothScroll } from "./SmoothScroll";
export { useReduced, useReveal, usePlay, useMounted } from "./hooks";
export * from "./tokens";
