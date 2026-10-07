import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Tailwind-merge that knows the library's own theme keys, so a consumer's
 * `className="rounded-ui-tile"` replaces a component's `rounded-ui-card`
 * instead of both landing in the class list.
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["ui-card", "ui-tile", "ui-row", "ui-key", "ui-sheet", "ui-field"],
      shadow: ["ui-pop", "ui-nav", "ui-card"],
      font: ["satoshi"],
      ease: ["ui-spring", "ui-out"],
      animate: ["ui-shimmer", "ui-caret"],
    },
  },
});

/** Join class names, later ones winning Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
