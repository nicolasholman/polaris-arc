"use client";

import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import { ThemeScope, type Theme } from "../primitives/Card";

/** A gallery section, named after the reference it reproduces. */
export function Section({
  id,
  eyebrow,
  title,
  description,
  children,
  className,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-24 py-10 md:py-14", className)}>
      <header className="mb-6 max-w-[760px] md:mb-8">
        <p className="text-[13px] font-medium tracking-[0.06em] text-ui-muted uppercase">{eyebrow}</p>
        <h2 id={`${id}-title`} className="mt-1.5 text-[28px] leading-tight font-medium tracking-[-0.03em] md:text-[36px]">
          {title}
        </h2>
        <div className="mt-2 text-[15px] leading-[1.5] text-ui-muted">{description}</div>
      </header>
      {children}
    </section>
  );
}

/** A phone-width screen in the reference's own theme. Full width on a phone. */
export function Screen({
  theme,
  label,
  children,
  className,
}: {
  theme: Theme;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <figcaption className="px-1 text-[13px] text-ui-muted">{label}</figcaption>
      <ThemeScope
        theme={theme}
        className={cn(
          // Full-bleed on a phone (the gallery's own gutter cancelled), so each
          // screen is exactly phone width; framed from 640px.
          "relative -mx-4 flex flex-col gap-5 overflow-hidden rounded-[32px] bg-ui-canvas px-5 pt-3 pb-6 font-satoshi sm:mx-0 md:rounded-[44px]",
          theme === "light" ? "ring-1 ring-black/5" : "ring-1 ring-white/5",
          theme === "light" && "bg-white",
          className,
        )}
      >
        {children}
      </ThemeScope>
    </figure>
  );
}

/** Three screens side by side from 1100px, stacked below. */
export function Screens({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 items-start gap-6 min-[1100px]:grid-cols-3 min-[1100px]:gap-8">{children}</div>;
}

/** A labelled row of specimens. */
export function Specimen({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="mb-3 text-[13px] font-medium text-ui-muted">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** A dark or light panel on the page. */
export function Panel({
  theme,
  children,
  className,
}: {
  theme?: Theme;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ThemeScope
      theme={theme ?? "dark"}
      className={cn("min-w-0 rounded-ui-card p-5 font-satoshi md:p-6", theme === "light" ? "bg-ui-surface-1" : "bg-ui-canvas", className)}
    >
      {children}
    </ThemeScope>
  );
}
