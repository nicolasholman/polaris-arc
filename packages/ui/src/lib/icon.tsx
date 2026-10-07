import { LucideProvider } from "lucide-react";
import type { ReactNode } from "react";

/** The references' outline icons: lucide at 1.75 stroke. */
export const ICON_STROKE = 1.75;

/**
 * Sizes and strokes whatever icon it wraps, so `icon={<Bell />}` comes out
 * at the slot's size and 1.75 stroke without the caller repeating it.
 * Props set on the icon itself still win.
 */
export function IconSlot({ children, size = 20, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <span aria-hidden className={className ?? "inline-grid shrink-0 place-items-center"} style={{ width: size, height: size }}>
      <LucideProvider size={size} strokeWidth={ICON_STROKE}>
        {children}
      </LucideProvider>
    </span>
  );
}

/** Wrap an app (or a subtree) so every lucide icon in it defaults to 1.75 stroke. */
export function IconProvider({ children, size }: { children: ReactNode; size?: number }) {
  return (
    <LucideProvider strokeWidth={ICON_STROKE} size={size}>
      {children}
    </LucideProvider>
  );
}
