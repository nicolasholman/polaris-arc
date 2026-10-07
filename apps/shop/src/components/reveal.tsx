"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The store's one motion idea: photographs open like a shutter as they come
 * into view. The default state is visible (a slight inset and scale), so a
 * page without JavaScript, or with reduced motion, loses nothing.
 */
export function ImageReveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no observer: show at once
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} data-shown={shown ? "" : undefined} style={{ transitionDelay: `${delay}ms` }} className={`reveal ${className}`}>
      {children}
    </div>
  );
}
