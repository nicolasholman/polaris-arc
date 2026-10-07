/**
 * The Polaris mark, inlined so the SDK draws it without an asset request.
 * Same paths as packages/brand (a four-point star: green rim, lime face).
 */

export const MARK_VIEWBOX = "16 12 520 580";
export const MARK_OUTER =
  "M272.75 19.25 C234.43 201.65 229.25 269.62 24.75 309.00 C203.59 340.32 230.25 429.07 273.00 585.00 C318.08 425.91 340.04 338.84 524.50 309.00 C319.50 272.76 312.50 200.32 272.75 19.25Z";
export const MARK_INNER =
  "M272.75 52.25 C266.92 210.23 239.78 285.35 71.25 307.25 C209.40 327.64 260.85 393.28 272.75 530.50 C285.19 395.19 337.69 324.22 477.50 307.75 C304.53 284.01 284.32 212.19 272.75 52.25Z";

export const BRAND_COLORS = {
  lime: "#BFFA62",
  limeCta: "#9CEF5E",
  rim: "#2E8C0A",
  rimDeep: "#1F700B",
  ink: "#0F1011",
  surface: "#1A1B1D",
  text: "#F5F5F5",
  muted: "#8A8D93",
} as const;

/** The mark as an SVG string, for the non-React surfaces (the checkout overlay and the popup's loading page). */
export function markSvg(size: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<path fill="${BRAND_COLORS.rim}" d="${MARK_OUTER}"/>` +
    `<path fill="${BRAND_COLORS.lime}" stroke="#1F6B0A" stroke-opacity="0.55" stroke-width="2" stroke-linejoin="round" d="${MARK_INNER}"/>` +
    `</svg>`
  );
}
