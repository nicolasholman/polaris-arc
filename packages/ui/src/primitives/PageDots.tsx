"use client";

import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export type PageDotsProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "onSelect"> & {
  count: number;
  /** The current page, from 0. */
  index: number;
  /** Makes each dot a button that jumps to its page. */
  onSelect?: (index: number) => void;
  /** What the pages are, for screen readers ("Introduction"). */
  label?: string;
};

/**
 * Onboarding's page dots (ref B): the current page a short white bar, the
 * rest small dots at 30%. The bar slides between them.
 *
 * ```tsx
 * <PageDots count={3} index={page} onSelect={setPage} />
 * ```
 */
export function PageDots({ count, index, onSelect, label = "Pages", className, ...props }: PageDotsProps) {
  const dot = (i: number) =>
    cn(
      "block h-1.5 rounded-full transition-[width,background-color] duration-300 ease-ui-out motion-reduce:transition-none",
      i === index ? "w-6 bg-white" : "w-1.5 bg-white/30",
    );
  return (
    <div
      role={onSelect ? "group" : "img"}
      aria-label={onSelect ? label : `${label}: ${index + 1} of ${count}`}
      // As buttons each dot gets a 24px target, so they sit further apart.
      className={cn("flex items-center", onSelect ? "-mx-[9px]" : "gap-1.5", className)}
      {...props}
    >
      {Array.from({ length: count }, (_, i) =>
        onSelect ? (
          <button
            key={i}
            type="button"
            aria-label={`Page ${i + 1} of ${count}`}
            aria-current={i === index ? "step" : undefined}
            onClick={() => onSelect(i)}
            className="-my-[9px] rounded-full p-[9px] focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ui-focus"
          >
            <span className={dot(i)} />
          </button>
        ) : (
          <span key={i} aria-hidden className={dot(i)} />
        ),
      )}
    </div>
  );
}
