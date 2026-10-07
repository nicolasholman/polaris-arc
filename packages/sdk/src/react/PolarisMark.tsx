"use client";

import React, { type SVGProps } from "react";

import { BRAND_COLORS, MARK_INNER, MARK_OUTER, MARK_VIEWBOX } from "../brand.js";

export type PolarisMarkProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  /** One flat colour (currentColor), for a mark on a coloured button. */
  mono?: boolean;
  /** Accessible name. Empty (the default) hides it from assistive tech, for a mark next to the word "Polaris". */
  title?: string;
};

/**
 * The Polaris mark: a four-point star with a green rim and a lime face.
 * No gradient ids, so any number of copies can share a page.
 */
export function PolarisMark({ mono = false, title = "", className, ...props }: PolarisMarkProps) {
  const labelled = title !== "";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={MARK_VIEWBOX}
      className={className ? `plrs-mark ${className}` : "plrs-mark"}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...props}
    >
      {mono ? (
        <path fill="currentColor" d={MARK_OUTER} />
      ) : (
        <>
          <path fill={BRAND_COLORS.rim} d={MARK_OUTER} />
          <path fill={BRAND_COLORS.lime} stroke="#1F6B0A" strokeOpacity={0.55} strokeWidth={2} strokeLinejoin="round" d={MARK_INNER} />
        </>
      )}
    </svg>
  );
}
