/**
 * Text wordmarks for the logo strip, each with a simple geometric glyph.
 * These are deliberately not the companies' real logos.
 */

type GlyphName = "monad" | "privy" | "chainlink" | "agora" | "envio" | "nansen" | "circle" | "zerion";

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
    case "monad":
      return (
        <svg {...common} fill="none">
          <rect x="6" y="6" width="14" height="14" rx="3.5" transform="rotate(45 13 13)" stroke="currentColor" strokeWidth="2.6" />
        </svg>
      );
    case "privy":
      return (
        <svg {...common}>
          <circle cx="13" cy="11" r="8" fill="currentColor" />
          <rect x="9" y="17" width="4.5" height="7" rx="1.5" fill="currentColor" />
        </svg>
      );
    case "chainlink":
      return (
        <svg {...common} fill="none">
          <path d="M13 3.5 21.2 8.2v9.6L13 22.5l-8.2-4.7V8.2L13 3.5Z" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
        </svg>
      );
    case "agora":
      return (
        <svg {...common} fill="none">
          <circle cx="9.5" cy="13" r="6.5" stroke="currentColor" strokeWidth="2.4" />
          <circle cx="16.5" cy="13" r="6.5" fill="currentColor" />
        </svg>
      );
    case "envio":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="20" height="4" rx="2" fill="currentColor" />
          <rect x="3" y="11" width="14" height="4" rx="2" fill="currentColor" />
          <rect x="3" y="17" width="20" height="4" rx="2" fill="currentColor" />
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
