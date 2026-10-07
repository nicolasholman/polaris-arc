import { PolarisMark as BrandMark } from "@polaris/brand";
import wordmark from "@polaris/brand/assets/wordmark.png";

import { cn } from "@/lib/cn";

/** The mark's own aspect ratio (its viewBox is 520 x 580). */
const MARK_RATIO = 520 / 580;

/**
 * The Polaris mark: the team's four-point star, green rim and lime face.
 * Decorative wherever it sits next to the word, so it carries no label.
 */
export function PolarisMark({ className, size = 30 }: { className?: string; size?: number }) {
  return (
    <BrandMark
      title=""
      width={Math.round(size * MARK_RATIO)}
      height={size}
      focusable="false"
      className={className}
    />
  );
}

/**
 * The team's glossy "Polaris" logotype. It is raster artwork with its own star
 * on the swoosh, so it stands alone rather than beside the mark.
 *
 * The height always comes from `className` (default h-[34px]) and the width
 * follows the artwork (872 x 263). Never pair it with h-auto: an img with an
 * auto height and an auto width falls back to its natural 872px size.
 */
export function PolarisWordmark({ className = "h-[34px]" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={wordmark.src}
      width={wordmark.width}
      height={wordmark.height}
      alt="Polaris"
      decoding="async"
      className={cn("block w-auto max-w-none select-none", className)}
      draggable={false}
    />
  );
}

/** The logotype, for the footer and anywhere static. */
export function PolarisLogo({ className }: { className?: string; size?: number }) {
  return <PolarisWordmark className={cn("h-[36px]", className)} />;
}
