/// <reference path="../assets.d.ts" />
import { PolarisMark } from "@polaris/brand";
import wordmark from "@polaris/brand/assets/wordmark.png";

import { cn } from "../lib/cn";

type StaticImage = { src: string; width: number; height: number };

/** Next.js imports images as { src, width, height }; other bundlers as a URL. */
const art: StaticImage = typeof wordmark === "string" ? { src: wordmark, width: 872, height: 263 } : wordmark;

/** The mark's own aspect ratio (its viewBox is 520 x 580). */
const MARK_RATIO = 520 / 580;

/**
 * The team's glossy "Polaris" logotype (packages/brand/assets/wordmark.png).
 * It has its own star on the swoosh, so it stands alone. The height is the
 * size; the width follows the artwork.
 *
 * ```tsx
 * <Logo height={30} />
 * ```
 */
export function Logo({ height = 30, className, alt = "Polaris" }: { height?: number; className?: string; alt?: string }) {
  const width = Math.round((art.width / art.height) * height);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={art.src}
      width={width}
      height={height}
      alt={alt}
      decoding="async"
      draggable={false}
      className={cn("block max-w-none shrink-0 select-none", className)}
      style={{ width, height }}
    />
  );
}

/**
 * The four-point star alone, where only a symbol fits (favicons, avatars,
 * a collapsed sidebar).
 *
 * ```tsx
 * <LogoMark size={28} />
 * ```
 */
export function LogoMark({ size = 28, className, title = "Polaris" }: { size?: number; className?: string; title?: string }) {
  return (
    <PolarisMark
      title={title}
      width={Math.round(size * MARK_RATIO)}
      height={size}
      focusable="false"
      className={cn("shrink-0", className)}
    />
  );
}
