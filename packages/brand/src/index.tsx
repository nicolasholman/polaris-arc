import type { SVGProps } from "react";

import { MARK_INNER, MARK_OUTER, MARK_VIEWBOX } from "./paths";

export { MARK_INNER, MARK_OUTER, MARK_VIEWBOX };

/** The lime face of the mark, and the rim's shades from light to deep. */
export const BRAND = {
  lime: "#BFFA62",
  rimLight: "#3BA00A",
  rim: "#2E8C0A",
  rimDeep: "#1F700B",
} as const;

type MarkProps = SVGProps<SVGSVGElement> & {
  /** One flat colour (currentColor unless `fill` is set), for embossing, favicons on colour, and print. */
  mono?: boolean;
  /** Accessible name. Pass an empty string when the mark sits beside the word "Polaris". */
  title?: string;
};

/**
 * The Polaris mark: a four-point star with a green rim and a lime face.
 *
 * No hooks, so it renders in server components. The gradient id is fixed; every
 * copy on a page defines the same gradient, so duplicates are harmless.
 */
export function PolarisMark({ mono = false, title = "Polaris", ...props }: MarkProps) {
  const labelled = title !== "";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={MARK_VIEWBOX}
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      {...props}
    >
      {labelled ? <title>{title}</title> : null}
      {mono ? (
        <path fill={props.fill ?? "currentColor"} d={MARK_OUTER} />
      ) : (
        <>
          <defs>
            <linearGradient id="polaris-mark-rim" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2F8E0A" />
              <stop offset="0.22" stopColor={BRAND.rimLight} />
              <stop offset="0.42" stopColor={BRAND.rim} />
              <stop offset="0.55" stopColor="#237A0B" />
              <stop offset="1" stopColor={BRAND.rimDeep} />
            </linearGradient>
          </defs>
          <path fill="url(#polaris-mark-rim)" d={MARK_OUTER} />
          <path
            fill={BRAND.lime}
            stroke="#1F6B0A"
            strokeOpacity={0.55}
            strokeWidth={2}
            strokeLinejoin="round"
            d={MARK_INNER}
          />
        </>
      )}
    </svg>
  );
}
