"use client";

import { useMotionValue, useMotionValueEvent, useSpring, useVelocity } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useReduced } from "./hooks";

export type RollingNumberProps = {
  value: number;
  format: (n: number) => string;
  className?: string;
  stiffness?: number;
  damping?: number;
};

/**
 * A number that tweens to each new value on a spring. While it moves, each
 * digit blurs in proportion to how fast it is changing, so the cents smear
 * and the thousands stay sharp, as in the reference.
 */
export function RollingNumber({
  value,
  format,
  className,
  stiffness = 150,
  damping = 26,
}: RollingNumberProps) {
  const reduced = useReduced();
  const target = useMotionValue(value);
  const spring = useSpring(target, { stiffness, damping, mass: 0.7 });
  const velocity = useVelocity(spring);
  const ref = useRef<HTMLSpanElement>(null);
  const [initial] = useState(() => format(value));

  useEffect(() => {
    if (reduced) spring.jump(value);
    else target.set(value);
  }, [value, reduced, spring, target]);

  useMotionValueEvent(spring, "change", (latest) => {
    const el = ref.current;
    if (!el) return;
    const text = format(latest);
    const speed = Math.abs(velocity.get());

    if (el.childElementCount !== text.length || el.firstChild?.nodeType === Node.TEXT_NODE) {
      const spans = Array.from(text, () => {
        const span = document.createElement("span");
        span.style.display = "inline-block";
        return span;
      });
      el.replaceChildren(...spans);
    }

    // Place value of each digit, counted out from the decimal point.
    const point = text.indexOf(".") === -1 ? text.length : text.indexOf(".");
    let digitsLeft = 0;
    for (let i = point - 1; i >= 0; i--) if (/\d/.test(text[i] ?? "")) digitsLeft++;

    let place = digitsLeft - 1;
    let fraction = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] ?? "";
      const span = el.children[i] as HTMLSpanElement | undefined;
      if (!span) continue;
      if (span.textContent !== ch) span.textContent = ch;
      let blur = 0;
      if (/\d/.test(ch)) {
        const exponent = i < point ? place-- : fraction--;
        const changesPerSecond = speed / Math.pow(10, exponent);
        blur = Math.min(1, Math.max(0, (changesPerSecond - 6) / 14)) * 5;
      }
      span.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
      span.style.opacity = blur > 0.05 ? String(1 - blur / 12) : "";
    }
  });

  return (
    <span className={className}>
      <span className="sr-only">{format(value)}</span>
      <span ref={ref} aria-hidden="true">
        {initial}
      </span>
    </span>
  );
}
