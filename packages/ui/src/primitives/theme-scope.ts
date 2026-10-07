/**
 * The theme scope an element sits in, when it is a nested one (a dark panel
 * in a light shell): a portalled popover (Menu, Select) carries it. The
 * page's own theme, on <html> (with the app's `data-theme-lg`), already
 * reaches <body>: copying it would override `data-theme-lg` on the desktop
 * layout.
 */
export function nestedTheme(el: Element): string | null {
  const scope = el.closest("[data-theme]");
  return scope && scope !== document.documentElement ? scope.getAttribute("data-theme") : null;
}
