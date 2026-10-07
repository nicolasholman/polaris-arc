"use client";

import Lenis from "lenis";
import { MotionConfig, MotionGlobalConfig } from "motion/react";
import { useEffect } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/*
 * Under reduced motion every Motion animation jumps straight to its final
 * state. Set as the module loads, so it is in place before anything animates.
 */
if (typeof window !== "undefined") {
  MotionGlobalConfig.skipAnimations = window.matchMedia(REDUCED_QUERY).matches;
}

/**
 * Lenis smooth scrolling for the whole page, plus Motion's config. Sections
 * stay in normal flow; Motion's scroll hooks read the native scroll position
 * that Lenis drives. Both stand down when the visitor prefers reduced motion.
 */
export function SmoothScroll({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const mql = window.matchMedia(REDUCED_QUERY);
    let lenis: Lenis | null = null;

    const apply = () => {
      MotionGlobalConfig.skipAnimations = mql.matches;
      if (mql.matches) {
        lenis?.destroy();
        lenis = null;
      } else if (!lenis) {
        lenis = new Lenis({
          autoRaf: true,
          duration: 1.1,
          easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
          anchors: { offset: 0 },
          smoothWheel: true,
        });
      }
    };

    apply();
    mql.addEventListener("change", apply);
    return () => {
      mql.removeEventListener("change", apply);
      lenis?.destroy();
    };
  }, []);

  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
