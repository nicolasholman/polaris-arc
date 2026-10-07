import { forwardRef, useId, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconSlot } from "../lib/icon";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
export type Pastel =
  | "blue"
  | "yellow"
  | "lilac"
  | "salmon"
  | "cyan"
  | "mint"
  | "teal"
  | "pink"
  | "sage"
  | "sky"
  | "honey"
  | "lime"
  | "purple";

const PX: Record<AvatarSize, number> = { xs: 24, sm: 32, md: 44, lg: 56, xl: 64 };
const TEXT: Record<AvatarSize, string> = {
  xs: "text-[10px]",
  sm: "text-[12px]",
  md: "text-[15px]",
  lg: "text-[19px]",
  xl: "text-[22px]",
};

/** Background for each pastel; ink text reads on all of them. */
export const PASTEL_BG: Record<Pastel, string> = {
  blue: "bg-ui-blue",
  yellow: "bg-ui-yellow",
  lilac: "bg-ui-lilac",
  salmon: "bg-ui-salmon",
  cyan: "bg-ui-cyan",
  mint: "bg-ui-mint",
  teal: "bg-ui-teal",
  pink: "bg-ui-pink",
  sage: "bg-ui-sage",
  sky: "bg-ui-sky",
  honey: "bg-ui-honey",
  lime: "bg-ui-lime",
  purple: "bg-ui-purple",
};

const HASHED: Pastel[] = ["blue", "yellow", "lilac", "salmon", "cyan", "mint", "pink", "sage", "sky", "honey"];

/** The same person always gets the same pastel. */
export function pastelFor(name: string): Pastel {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HASHED[h % HASHED.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

export type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  /** The person or merchant. Gives the initials, the alt text and the pastel. */
  name: string;
  /** A photo or logo URL. */
  src?: string;
  /** An icon or logo node instead of initials (a merchant's brand circle). */
  icon?: ReactNode;
  /** A pastel, or leave it to the name's hash. */
  tone?: Pastel;
  /** Any CSS colour for the circle (a brand colour); wins over `tone`. */
  color?: string;
  /** Text colour on `color`. */
  fg?: string;
  size?: AvatarSize;
  /** A ring in the ground colour, for stacks and overlaps. */
  ring?: boolean;
  /** A small badge on the bottom-right edge (a FlagBadge, a status dot). */
  badge?: ReactNode;
  /** Decorative: hide from assistive tech when a name sits beside it. */
  decorative?: boolean;
};

/**
 * A person's photo or initials on a pastel, or a merchant's brand circle.
 *
 * ```tsx
 * <Avatar name="Mia Bennett" size="lg" />
 * <Avatar name="Walmart" color="#1a73e8" icon={<Store />} />
 * <Avatar name="Ana" badge={<FlagBadge code="MX" />} />
 * ```
 */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, src, icon, tone, color, fg, size = "md", ring = false, badge, decorative = false, className, style, ...props },
  ref,
) {
  const px = PX[size];
  const pastel = tone ?? pastelFor(name);
  return (
    <span
      ref={ref}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: px, height: px, ...style }}
      {...props}
    >
      <span
        className={cn(
          "grid size-full place-items-center overflow-hidden rounded-full font-satoshi leading-none font-semibold tracking-[-0.02em] text-[#13141f] select-none",
          TEXT[size],
          !color && PASTEL_BG[pastel],
          ring && "ring-[3px] ring-ui-canvas",
        )}
        style={color ? { background: color, color: fg ?? "#ffffff" } : undefined}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="size-full object-cover" draggable={false} />
        ) : icon ? (
          <IconSlot size={Math.round(px * 0.46)}>{icon}</IconSlot>
        ) : (
          <span aria-hidden>{initials(name)}</span>
        )}
      </span>
      {badge ? <span className="absolute -right-0.5 -bottom-0.5">{badge}</span> : null}
    </span>
  );
});

/* ── AvatarStack ─────────────────────────────────────────────────────────── */

export type AvatarStackProps = HTMLAttributes<HTMLDivElement> & {
  people: { name: string; src?: string; tone?: Pastel }[];
  size?: AvatarSize;
  /** Show at most this many, then "+N". */
  max?: number;
};

/**
 * Overlapping avatars with a "+N" tail.
 *
 * ```tsx
 * <AvatarStack people={customers} max={4} size="sm" />
 * ```
 */
export function AvatarStack({ people, size = "sm", max = 4, className, ...props }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  const px = PX[size];
  return (
    <div
      role="group"
      aria-label={`${people.length} ${people.length === 1 ? "person" : "people"}`}
      className={cn("flex items-center", className)}
      {...props}
    >
      {shown.map((p, i) => (
        <Avatar
          key={`${p.name}-${i}`}
          name={p.name}
          src={p.src}
          tone={p.tone}
          size={size}
          ring
          style={{ marginLeft: i === 0 ? 0 : -Math.round(px * 0.28) }}
        />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            "ui-figure grid place-items-center rounded-full bg-ui-surface-3 font-satoshi font-medium text-ui-text ring-[3px] ring-ui-canvas",
            TEXT[size],
          )}
          style={{ width: px, height: px, marginLeft: -Math.round(px * 0.28) }}
          aria-label={`and ${rest} more`}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}

/* ── FlagBadge ───────────────────────────────────────────────────────────── */

export type FlagCode = "US" | "EU" | "GB" | "IN" | "NG" | "MX" | "BR" | "CA";

const FLAG_NAMES: Record<FlagCode, string> = {
  US: "United States",
  EU: "European Union",
  GB: "United Kingdom",
  IN: "India",
  NG: "Nigeria",
  MX: "Mexico",
  BR: "Brazil",
  CA: "Canada",
};

function FlagArt({ code }: { code: FlagCode }) {
  switch (code) {
    case "US":
      return (
        <>
          <rect width="24" height="24" fill="#fff" />
          {[0, 2, 4, 6, 8, 10, 12].map((i) => (
            <rect key={i} y={(i * 24) / 13} width="24" height={24 / 13} fill="#B22234" />
          ))}
          <rect width="11" height={(24 / 13) * 7} fill="#3C3B6E" />
          {[2.2, 5.5, 8.8].map((x) =>
            [2.2, 5.6, 9.2].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="0.8" fill="#fff" />),
          )}
        </>
      );
    case "EU":
      return (
        <>
          <rect width="24" height="24" fill="#003399" />
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i / 12) * Math.PI * 2;
            // Rounded so the server and the browser print the same numbers.
            const cx = Math.round((12 + Math.cos(a) * 6) * 1000) / 1000;
            const cy = Math.round((12 + Math.sin(a) * 6) * 1000) / 1000;
            return <circle key={i} cx={cx} cy={cy} r="0.95" fill="#FFCC00" />;
          })}
        </>
      );
    case "GB":
      return (
        <>
          <rect width="24" height="24" fill="#012169" />
          <path d="M0 0 24 24M24 0 0 24" stroke="#fff" strokeWidth="5" />
          <path d="M0 0 24 24M24 0 0 24" stroke="#C8102E" strokeWidth="1.8" />
          <path d="M12 0v24M0 12h24" stroke="#fff" strokeWidth="7" />
          <path d="M12 0v24M0 12h24" stroke="#C8102E" strokeWidth="4" />
        </>
      );
    case "IN":
      return (
        <>
          <rect width="24" height="8" fill="#FF9933" />
          <rect y="8" width="24" height="8" fill="#fff" />
          <rect y="16" width="24" height="8" fill="#138808" />
          <circle cx="12" cy="12" r="2.6" fill="none" stroke="#000080" strokeWidth="0.9" />
        </>
      );
    case "NG":
      return (
        <>
          <rect width="8" height="24" fill="#008751" />
          <rect x="8" width="8" height="24" fill="#fff" />
          <rect x="16" width="8" height="24" fill="#008751" />
        </>
      );
    case "MX":
      return (
        <>
          <rect width="8" height="24" fill="#006847" />
          <rect x="8" width="8" height="24" fill="#fff" />
          <rect x="16" width="8" height="24" fill="#CE1126" />
          <circle cx="12" cy="12" r="2" fill="#8C5A2B" />
        </>
      );
    case "BR":
      return (
        <>
          <rect width="24" height="24" fill="#009C3B" />
          <path d="M12 3.5 22 12 12 20.5 2 12Z" fill="#FFDF00" />
          <circle cx="12" cy="12" r="4.6" fill="#002776" />
        </>
      );
    case "CA":
      return (
        <>
          <rect width="24" height="24" fill="#fff" />
          <rect width="6" height="24" fill="#D80621" />
          <rect x="18" width="6" height="24" fill="#D80621" />
          <path d="M12 6.5 13.2 9.4 15.2 8.8 14.4 12.4 16.2 12 12.6 15.6V18H11.4V15.6L7.8 12 9.6 12.4 8.8 8.8 10.8 9.4Z" fill="#D80621" />
        </>
      );
  }
}

export type FlagBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  code: FlagCode;
  /** Diameter in px. */
  size?: number;
  ring?: boolean;
};

/**
 * A round currency or country flag, alone or on an avatar's edge.
 *
 * ```tsx
 * <FlagBadge code="US" />
 * <Avatar name="Ana" badge={<FlagBadge code="MX" size={16} />} />
 * ```
 */
export function FlagBadge({ code, size = 20, ring = true, className, ...props }: FlagBadgeProps) {
  const id = useId();
  return (
    <span
      role="img"
      aria-label={FLAG_NAMES[code]}
      className={cn("inline-block shrink-0 overflow-hidden rounded-full", ring && "ring-2 ring-ui-canvas", className)}
      style={{ width: size, height: size }}
      {...props}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
        <clipPath id={`${id}-c`}>
          <circle cx="12" cy="12" r="12" />
        </clipPath>
        <g clipPath={`url(#${id}-c)`}>
          <FlagArt code={code} />
        </g>
      </svg>
    </span>
  );
}
