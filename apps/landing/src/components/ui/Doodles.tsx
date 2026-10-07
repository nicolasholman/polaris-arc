import type { SVGProps } from "react";

/**
 * Line-art doodles, drawn inline so they stay crisp and take the card's
 * colours: the outline flower on the dark "pay in 4" card and the leaf-arrow
 * on the calculator.
 */

export function FlowerDoodle(props: SVGProps<SVGSVGElement>) {
  const petal = "M0 0C-26-24-30-78 0-104 30-78 26-24 0 0Z";
  return (
    <svg viewBox="-130 -130 260 260" fill="none" aria-hidden="true" focusable="false" {...props}>
      <g stroke="currentColor" strokeWidth="5" strokeLinejoin="round" transform="rotate(18)">
        <path d={petal} />
        <path d={petal} transform="rotate(90)" />
        <path d={petal} transform="rotate(180)" />
        <path d={petal} transform="rotate(270)" />
        <path d="M0 0C-10-18-12-44 0-58 12-44 10-18 0 0Z" transform="rotate(45)" />
        <path d="M0 0C-10-18-12-44 0-58 12-44 10-18 0 0Z" transform="rotate(225)" />
        <circle r="9" />
      </g>
    </svg>
  );
}

export function LeafArrowDoodle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 120 150" fill="none" aria-hidden="true" focusable="false" {...props}>
      <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {/* The arrowhead, drawn as an outline like a folded leaf. */}
        <path d="M50 30 106 12 90 66" />
        <path d="M58 36 98 22 86 58" />
        <path d="M106 12 60 60" />
        {/* The looping stem. */}
        <path d="M60 60C44 76 40 98 52 116c10 15 30 16 38 4 8-12-2-28-18-26-18 2-26 22-22 46" />
      </g>
    </svg>
  );
}
