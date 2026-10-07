"use client";

import { MinusIcon, PlusIcon } from "@/components/icons";

export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 10,
  label,
  size = "md",
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  label: string;
  size?: "sm" | "md";
}) {
  const h = size === "sm" ? "h-9" : "h-[3.25rem]";
  const w = size === "sm" ? "w-9" : "w-12";
  return (
    <div role="group" aria-label={label} className={`inline-flex ${h} items-center rounded-full shadow-[inset_0_0_0_1px_var(--color-hair-strong)]`}>
      <button
        type="button"
        className={`inline-flex ${h} ${w} items-center justify-center rounded-full text-ink transition-opacity disabled:opacity-30`}
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label={`Decrease ${label.toLowerCase()}`}
      >
        <MinusIcon size={size === "sm" ? 15 : 17} />
      </button>
      <output aria-live="polite" className={`num min-w-6 text-center ${size === "sm" ? "text-[0.9rem]" : "text-[1rem]"}`}>
        {value}
      </output>
      <button
        type="button"
        className={`inline-flex ${h} ${w} items-center justify-center rounded-full text-ink transition-opacity disabled:opacity-30`}
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={`Increase ${label.toLowerCase()}`}
      >
        <PlusIcon size={size === "sm" ? 15 : 17} />
      </button>
    </div>
  );
}
