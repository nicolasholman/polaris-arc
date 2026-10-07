import Image from "next/image";

import { cn } from "@polaris/ui";

/**
 * The glass renders from the Polaris app's onboarding (coins in lime, purple
 * and crimson, the lime card with the star, the pin), as stills. Decorative.
 */
export type GlassArt = "coin-lime" | "coin-purple" | "coin-crimson" | "card-lime" | "pin";

export function Glass({
  art,
  size,
  className,
  priority = false,
  eager = false,
}: {
  art: GlassArt;
  size: number;
  className?: string;
  /** Above the fold: preload it (and load it eagerly). */
  priority?: boolean;
  /** Load eagerly without a preload: a large render that can become the page's LCP once scrolled to. */
  eager?: boolean;
}) {
  return (
    <Image
      src={`/assets/glass/${art}.png`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      sizes={`${size}px`}
      preload={priority}
      loading={priority || eager ? "eager" : "lazy"}
      draggable={false}
      className={cn("pointer-events-none select-none", className)}
    />
  );
}
