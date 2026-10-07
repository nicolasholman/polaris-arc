"use client";

import { useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { useControllable } from "../lib/hooks";
import { Money } from "../primitives/Money";

export type MiniCard = {
  id: string;
  /** Top-left mark: a logo, an icon. */
  mark?: ReactNode;
  /** Shown as "**** 4523". */
  last4?: string;
  /** Or a name instead of the masked number. */
  title?: string;
  /** Dollars. */
  balance: number;
  /** The card's dark tint (ref A: brown, indigo, plum, slate). */
  tint?: string;
};

export const MINI_CARD_TINTS = ["#351e1f", "#2e283e", "#3f273d", "#23313a"];

export type MiniCardCarouselProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> & {
  cards: MiniCard[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  "aria-label"?: string;
};

/**
 * Ref A's small account cards on the transfer screen: a scrolling rail of
 * dark tinted tiles, the chosen one ringed in lime.
 *
 * ```tsx
 * <MiniCardCarousel aria-label="Pay from" cards={accounts} value={from} onValueChange={setFrom} />
 * ```
 */
export function MiniCardCarousel({
  cards,
  value,
  defaultValue,
  onValueChange,
  className,
  "aria-label": ariaLabel = "Account",
  ...props
}: MiniCardCarouselProps) {
  const [current, setCurrent] = useControllable({ value, defaultValue: defaultValue ?? cards[0]?.id ?? "", onChange: onValueChange });
  const ref = useRef<HTMLDivElement>(null);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = cards.findIndex((c) => c.id === current);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(cards.length - 1, i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, i - 1);
    if (next < 0) return;
    e.preventDefault();
    setCurrent(cards[next]!.id);
    const el = ref.current?.querySelectorAll<HTMLElement>("[role=radio]")[next];
    el?.focus();
    el?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={cn("ui-no-scrollbar -mx-5 flex snap-x scroll-px-5 gap-2 overflow-x-auto px-5 py-1 font-satoshi", className)}
      {...props}
    >
      {cards.map((c, i) => {
        const on = c.id === current;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => setCurrent(c.id)}
            className={cn(
              "flex h-[104px] w-[108px] shrink-0 snap-start flex-col justify-between rounded-[16px] p-3 text-left text-white",
              "transition-[transform,box-shadow] duration-200 ease-ui-spring active:scale-[0.96] motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus",
              on ? "shadow-[inset_0_0_0_1.5px_var(--ui-lime)]" : "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]",
            )}
            style={{ background: c.tint ?? MINI_CARD_TINTS[i % MINI_CARD_TINTS.length] }}
          >
            <span className="flex h-6 items-center">{c.mark}</span>
            <span>
              <span className="ui-figure block truncate text-[12px] leading-tight text-white/85">
                {c.title ?? (
                  <>
                    <span aria-hidden>**** </span>
                    <span className="sr-only">ending in </span>
                    {c.last4}
                  </>
                )}
              </span>
              <Money value={c.balance} dim="symbol" dimOpacity={0.5} className="mt-0.5 text-[15px] leading-tight font-medium" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
