/**
 * Where a portalled Menu goes. Pure, so it is tested on its own
 * (`packages/ui/test/menu-position.test.ts`).
 */

export type MenuPosition = { left: number; top: number; width: number; above: boolean; theme: string | null };

/** The gap between the trigger and the menu, and the menu and the viewport's edge. */
const GAP = 8;
const EDGE = 12;

/**
 * Where the portalled menu goes, in viewport (fixed) coordinates: under the
 * trigger (or over it for `side="top"`), lined up with its start or end
 * edge, flipped to the other side when the preferred one hasn't room and the
 * other has, and kept `EDGE` px inside the viewport. With `above`, `top` is
 * the menu's bottom edge (the menu is translated up by its own height).
 */
export function placeMenu(input: {
  trigger: { top: number; bottom: number; left: number; right: number };
  menuHeight: number;
  width: number;
  align: "start" | "end";
  side: "bottom" | "top";
  viewport: { width: number; height: number };
  theme?: string | null;
}): MenuPosition {
  const { trigger: r, menuHeight: h, align, side, viewport } = input;
  const width = Math.min(input.width, viewport.width - EDGE * 2);
  const roomBelow = viewport.height - r.bottom - GAP - EDGE;
  const roomAbove = r.top - GAP - EDGE;
  const above = side === "top" ? !(h > roomAbove && h <= roomBelow) : h > roomBelow && h <= roomAbove;
  const left = align === "end" ? r.right - width : r.left;
  return {
    left: Math.max(EDGE, Math.min(left, viewport.width - width - EDGE)),
    top: above ? r.top - GAP : r.bottom + GAP,
    width,
    above,
    theme: input.theme ?? null,
  };
}
