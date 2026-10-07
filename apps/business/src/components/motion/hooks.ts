"use client";

import { useInView } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { VIEW_AMOUNT } from "./tokens";

export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * True when the visitor asked for reduced motion. Primitives then render their
 * final state and skip the animation.
 *
 * It reads false while hydrating (matching the server HTML) and switches right
 * after, so the markup never mismatches; the CSS in globals.css already shows
 * every reveal in its final state before that.
 */
export function useReduced(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

/**
 * A ref plus whether it has entered the viewport (once). `amount` is the share
 * of the element that must be visible: 20% by default, as the spec asks.
 */
export function useReveal<T extends Element>(amount: number = VIEW_AMOUNT) {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { once: true, amount });
  return [ref, inView] as const;
}

/**
 * Like useReveal, but measured from the element's box rather than by an
 * IntersectionObserver. Chrome intersects against an element's own
 * clip-path, so a card that starts mostly clipped (Grow) would never count
 * as 20% visible; this checks the unclipped box on scroll instead.
 */
export function useVisibleOnce<T extends Element>(amount: number = VIEW_AMOUNT) {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const seen = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      const need = Math.min(r.height, vh) * amount;
      if (seen > 0 && seen >= need) setVisible(true);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [amount, visible]);

  return [ref, visible] as const;
}

/**
 * Resolves the "should this animate to its final state now" flag for a
 * primitive: an explicit `play` wins, otherwise the element's own visibility.
 */
export function usePlay<T extends Element>(play: boolean | undefined, amount?: number) {
  const [ref, inView] = useReveal<T>(amount);
  const reduced = useReduced();
  const shown = reduced || (play ?? inView);
  return { ref, shown, reduced } as const;
}

const noSubscribe = () => () => undefined;

/** True after hydration; the server (and the hydrating render) read false. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}
