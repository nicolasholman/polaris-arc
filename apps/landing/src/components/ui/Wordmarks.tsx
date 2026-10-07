/**
 * Text wordmarks for the logo strip, each with a simple geometric glyph.
 * These are deliberately not the companies' real logos.
 */

type GlyphName = "arc" | "circle" | "cctp" | "eurc" | "privy" | "nansen" | "zerion";

function Glyph({ name }: { name: GlyphName }) {
  // Scales with the wordmark: 30px beside the 32px desktop text.
  const common = {
    width: "0.94em",
    height: "0.94em",
    viewBox: "0 0 26 26",
    "aria-hidden": true as const,
    focusable: false as const,
  };
  switch (name) {
    case "arc":
      return (
        <svg {...common} fill="none">
          <path d="M4 17a9 9 0 0 1 18 0" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="13" cy="17" r="2.6" fill="currentColor" />
        </svg>
      );
    case "cctp":
      return (
        <svg {...common} fill="none">
          <path d="M4 9h17m-4.5-4.5L21 9l-4.5 4.5M22 17H5m4.5-4.5L5 17l4.5 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "eurc":
      return (
        <svg {...common} fill="none">
          <circle cx="13" cy="13" r="9" stroke="currentColor" strokeWidth="2.6" />
          <path d="M13 4a9 9 0 0 0 0 18Z" fill="currentColor" />
        </svg>
      );
    case "privy":
      return (
        <svg {...common}>
          <circle cx="13" cy="11" r="8" fill="currentColor" />
          <rect x="9" y="17" width="4.5" height="7" rx="1.5" fill="currentColor" />
        </svg>
      );
    case "nansen":
      return (
        <svg {...common}>
          <path d="M13 3.5 23 21.5H3L13 3.5Z" fill="currentColor" />
        </svg>
      );
    case "circle":
      return (
        <svg {...common} fill="none">
          <circle cx="13" cy="13" r="9" stroke="currentColor" strokeWidth="2.6" />
          <circle cx="13" cy="13" r="3.5" fill="currentColor" />
        </svg>
      );
    case "zerion":
      return (
        <svg {...common}>
          <path d="M4 5h18l-9 8h9v8H4l9-8H4V5Z" fill="currentColor" />
        </svg>
      );
  }
}

export function Wordmark({ name, glyph }: { name: string; glyph: GlyphName }) {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap text-[24px] font-semibold tracking-[-0.04em] text-olive lg:text-[32px]">
      <Glyph name={glyph} />
      {name}
    </span>
  );
}
