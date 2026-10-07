/**
 * Motion tokens from docs/design/landing.md ("Motion").
 */

/** cubic-bezier(.2,.7,.2,1): every reveal on the page. */
export const EASE_REVEAL = [0.2, 0.7, 0.2, 1] as const;

/** Word blur-in: 700ms per word. */
export const WORD_DURATION = 0.7;
/** 70ms between words. */
export const WORD_STAGGER = 0.07;
/** 80ms between paragraph lines. */
export const LINE_STAGGER = 0.08;
/** blur(12px) → 0. */
export const WORD_BLUR = 12;
/** translateY(0.25em) → 0. */
export const WORD_RISE = "0.25em";

/** Cards rise 40px and fade, staggered 120ms left to right. */
export const CARD_RISE = 40;
export const CARD_STAGGER = 0.12;

/** Headings trigger when 20% visible. */
export const VIEW_AMOUNT = 0.2;

/** Marquee speeds, px per second. */
export const LOGO_SPEED = 40;
export const CHIP_SPEED = 30;

/** FAQ open and close. */
export const ACCORDION_DURATION = 0.35;
