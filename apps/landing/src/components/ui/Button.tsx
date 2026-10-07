"use client";

import { motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { usePlay } from "@/components/motion/hooks";
import { cn } from "@/lib/cn";
import { ArrowRight } from "./icons";

type Variant = "olive" | "lime" | "outline" | "white" | "glass";
type Size = "sm" | "md" | "lg";

/* Hover is an overlay (::after), so it still shows once Motion owns the fill. */
const variants: Record<Variant, string> = {
  olive: "bg-olive text-white hover:after:bg-white/10",
  lime: "bg-lime text-olive hover:after:bg-black/[0.05]",
  outline: "border border-olive/30 bg-transparent text-olive hover:border-olive/60 hover:after:bg-olive/[0.05]",
  white: "bg-white text-olive hover:after:bg-black/[0.05]",
  glass: "bg-black/25 text-white backdrop-blur-md hover:after:bg-white/10",
};

const sizes: Record<Size, string> = {
  sm: "h-[42px] px-[18px] text-[15px] gap-2 lg:h-[46px] lg:px-5 lg:text-[16px]",
  md: "h-[46px] px-5 text-[16px] gap-2.5 lg:h-[50px] lg:px-[22px] lg:text-[17px]",
  lg: "h-[50px] px-6 text-[17px] gap-2.5 lg:h-[56px] lg:px-[26px] lg:text-[18px]",
};

/** How a button arrives: it fades in with its fill shifting from `from`. */
export type ButtonReveal = {
  play?: boolean;
  delay?: number;
  /** Starting background colour; the text shifts from `textFrom` if given. */
  from?: string;
  textFrom?: string;
};

const finalColours: Record<Variant, { bg: string; text: string }> = {
  olive: { bg: "#2d3a02", text: "#ffffff" },
  lime: { bg: "#e1ff67", text: "#2d3a02" },
  outline: { bg: "rgba(45,58,2,0)", text: "#2d3a02" },
  white: { bg: "#ffffff", text: "#2d3a02" },
  glass: { bg: "rgba(0,0,0,0.25)", text: "#ffffff" },
};

export type ButtonProps = {
  href: string;
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  arrow?: boolean;
  className?: string;
  reveal?: ButtonReveal;
};

/**
 * A fully rounded pill link. With `reveal`, it fades in while its fill moves
 * from a muted tone to its own colour, as the buttons in the reference do.
 */
export function Button({ href, children, variant = "olive", size = "md", arrow, className, reveal }: ButtonProps) {
  const { ref, shown, reduced } = usePlay<HTMLAnchorElement>(reveal?.play);
  const final = finalColours[variant];
  const delay = reveal?.delay ?? 0;
  // Under reduced motion `shown` is true and Motion skips straight to the end.
  const animated = Boolean(reveal);

  return (
    <motion.a
      ref={ref}
      href={href}
      className={cn(
        "rv relative inline-flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-full font-normal tracking-[-0.02em] transition-[border-color,transform] duration-300 after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:transition-colors after:duration-300 active:scale-[0.98]",
        // Without JS or with reduced motion, CSS shows the final fill.
        animated && "rv-fill",
        variants[variant],
        sizes[size],
        className,
      )}
      style={animated ? ({ "--rv-bg": final.bg, "--rv-fg": final.text } as CSSProperties) : undefined}
      initial={
        animated
          ? {
              opacity: 0,
              backgroundColor: reveal?.from ?? "#a8ac96",
              color: reveal?.textFrom ?? final.text,
            }
          : false
      }
      animate={
        animated
          ? shown
            ? { opacity: 1, backgroundColor: final.bg, color: final.text }
            : undefined
          : undefined
      }
      transition={{
        opacity: { delay, duration: 0.45, ease: "easeOut" },
        backgroundColor: { delay: delay + 0.15, duration: 0.7, ease: "easeOut" },
        color: { delay: delay + 0.15, duration: 0.7, ease: "easeOut" },
      }}
      whileHover={reduced ? undefined : { y: -1 }}
    >
      <span className="relative">{children}</span>
      {arrow ? <ArrowRight className="relative" size={size === "lg" ? 19 : 18} /> : null}
    </motion.a>
  );
}
