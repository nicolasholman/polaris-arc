import { useId } from "react";

/**
 * Round flags for the "Across borders" panel, drawn inline.
 */

type FlagProps = { size?: number; className?: string };

function Round({ size = 38, className, children, label }: FlagProps & { children: React.ReactNode; label: string }) {
  const clip = `flag-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 60 60"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={className}
    >
      <defs>
        <clipPath id={clip}>
          <circle cx="30" cy="30" r="30" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>{children}</g>
      <circle cx="30" cy="30" r="29.25" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.5" />
    </svg>
  );
}

export function FlagUK(props: FlagProps) {
  return (
    <Round {...props} label="United Kingdom">
      <rect width="60" height="60" fill="#012169" />
      <path d="M-5 -5 65 65M65 -5 -5 65" stroke="#fff" strokeWidth="12" />
      <path d="M-5 -5 65 65M65 -5 -5 65" stroke="#C8102E" strokeWidth="4.5" />
      <path d="M30 0v60M0 30h60" stroke="#fff" strokeWidth="18" />
      <path d="M30 0v60M0 30h60" stroke="#C8102E" strokeWidth="10" />
    </Round>
  );
}

export function FlagEU(props: FlagProps) {
  const stars = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return { x: 30 + Math.cos(a) * 15, y: 30 + Math.sin(a) * 15 };
  });
  return (
    <Round {...props} label="European Union">
      <rect width="60" height="60" fill="#003399" />
      {stars.map((s, i) => (
        <path
          key={i}
          transform={`translate(${s.x.toFixed(2)} ${s.y.toFixed(2)})`}
          d="M0 -2.6 0.76 -0.8 2.5 -0.8 1.1 0.3 1.6 2.1 0 1 -1.6 2.1 -1.1 0.3 -2.5 -0.8 -0.76 -0.8Z"
          fill="#FFCC00"
        />
      ))}
    </Round>
  );
}

export function FlagUS(props: FlagProps) {
  return (
    <Round {...props} label="United States">
      <rect width="60" height="60" fill="#fff" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} y={i * 9.23} width="60" height="4.6" fill="#B22234" />
      ))}
      <rect width="30" height="32" fill="#3C3B6E" />
      {Array.from({ length: 12 }, (_, i) => (
        <circle key={i} cx={5 + (i % 4) * 6.6} cy={5 + Math.floor(i / 4) * 9} r="1.3" fill="#fff" />
      ))}
    </Round>
  );
}
