"use client";

import { motion } from "motion/react";
import { Fragment, useRef, useState, type Ref } from "react";
import { cn } from "@polaris/ui";
import { wordVariants } from "./BlurWords";
import { useIsomorphicLayoutEffect, usePlay } from "./hooks";
import { LINE_STAGGER, WORD_DURATION } from "./tokens";

type Tag = "p" | "span" | "div" | "blockquote" | "h3" | "h4";

export type Segment = { text: string; className?: string };

export type BlurLinesProps = {
  /** Plain text, or coloured segments (a two-tone paragraph). */
  text: string | readonly Segment[];
  as?: Tag;
  className?: string;
  delay?: number;
  /** Seconds between lines (80ms). */
  stagger?: number;
  duration?: number;
  play?: boolean;
  amount?: number;
  id?: string;
};

/**
 * Line-by-line blur reveal for paragraphs. The words are laid out as normal
 * text, then grouped by the line they landed on, so it works at any width.
 * Every word on a line shares the line's delay; segments keep their colours.
 * The text is rendered once; a heading also gets its text as its name.
 */
export function BlurLines({
  text,
  as = "p",
  className,
  delay = 0,
  stagger = LINE_STAGGER,
  duration = WORD_DURATION,
  play,
  amount,
  id,
}: BlurLinesProps) {
  const segments: readonly Segment[] = typeof text === "string" ? [{ text }] : text;
  const words = segments.flatMap((segment) =>
    segment.text
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ word, className: segment.className })),
  );
  const plain = segments.map((s) => s.text).join(" ");

  const { ref, shown } = usePlay<HTMLElement>(play, amount);
  const wordRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [lineOf, setLineOf] = useState<number[]>([]);

  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const next: number[] = [];
      let line = -1;
      let lastTop = Number.NEGATIVE_INFINITY;
      wordRefs.current.forEach((el, i) => {
        if (!el) return;
        const top = el.offsetTop;
        if (Math.abs(top - lastTop) > 4) {
          line += 1;
          lastTop = top;
        }
        next[i] = line;
      });
      setLineOf((prev) =>
        prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next,
      );
    };
    measure();
    const host = ref.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [plain]);

  const children = words.map(({ word, className: tone }, i) => (
    <Fragment key={i}>
      <motion.span
        ref={(el: HTMLSpanElement | null) => {
          wordRefs.current[i] = el;
        }}
        className={cn("reveal-word", tone)}
        variants={wordVariants}
        custom={{ delay: delay + (lineOf[i] ?? 0) * stagger, duration }}
        initial="hidden"
        animate={shown ? "visible" : "hidden"}
      >
        {word}
      </motion.span>
      {i < words.length - 1 ? " " : null}
    </Fragment>
  ));

  const label = as === "h3" || as === "h4" ? plain : undefined;
  const Tag = as;
  return (
    <Tag ref={ref as Ref<never>} className={className} id={id} aria-label={label}>
      {children}
    </Tag>
  );
}
