import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    fill: "none",
    "aria-hidden": true as const,
    focusable: false as const,
    ...rest,
  };
}

export function ArrowRight(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" {...base(props)}>
      <path d="M3.5 10h12.2M11 4.8l5.2 5.2-5.2 5.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowLeft(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" {...base(props)}>
      <path d="M16.5 10H4.3M9 4.8 3.8 10 9 15.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The small arrow bullets on the mint card. */
export function ArrowSmall(props: IconProps) {
  return (
    <svg viewBox="0 0 14 14" {...base({ size: 12, ...props })}>
      <path d="M1.5 7h10M8 3.2 11.8 7 8 10.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 14 16" {...base({ size: 16, ...props })}>
      <path d="M2 3.5h10M2 8h10M2 12.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function GridDots(props: IconProps) {
  return (
    <svg viewBox="0 0 14 14" {...base({ size: 14, ...props })}>
      <circle cx="3.5" cy="3.5" r="2.6" fill="currentColor" />
      <circle cx="10.5" cy="3.5" r="2.6" fill="currentColor" />
      <circle cx="3.5" cy="10.5" r="2.6" fill="currentColor" />
      <circle cx="10.5" cy="10.5" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" {...base(props)}>
      <path d="M10 3.5v13M3.5 10h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base(props)}>
      <path
        fill="currentColor"
        d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z"
      />
    </svg>
  );
}

export function GithubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base(props)}>
      <path
        fill="currentColor"
        d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"
      />
    </svg>
  );
}

export function TelegramIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base(props)}>
      <path
        fill="currentColor"
        d="M20.7 3.3 2.9 10.2c-1.2.5-1.2 1.2-.2 1.5l4.6 1.4 1.7 5.4c.2.6.1.8.7.8.5 0 .7-.2 1-.5l2.2-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.5c.3-1.3-.5-1.8-1.7-1.5Zm-3 3.6-8.4 7.6-.3 3.5-1.6-4.9 9.8-6.2c.5-.3.9-.1.5 0Z"
      />
    </svg>
  );
}

export const socialIcons = {
  x: XIcon,
  github: GithubIcon,
  telegram: TelegramIcon,
} as const;
