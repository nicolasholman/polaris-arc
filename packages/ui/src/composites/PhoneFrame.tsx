import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn";

export type PhoneFrameProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode;
  /** Screen width in px; the height follows an iPhone's 19.5:9. */
  width?: number;
  /** The status bar's time. */
  time?: string;
  /** The screen's ground; defaults to the theme's canvas. */
  screenClassName?: string;
};

/**
 * A phone around live components: the references' iPhone framing (a graphite
 * rim, a 52px screen radius, the Dynamic Island), for marketing pages and the
 * gallery. The content is real and interactive; the frame is decoration.
 *
 * ```tsx
 * <PhoneFrame width={320}><CheckoutPreview /></PhoneFrame>
 * ```
 */
export function PhoneFrame({ children, width = 320, time = "9:41", screenClassName, className, style, ...props }: PhoneFrameProps) {
  const height = Math.round(width * (19.5 / 9));
  return (
    <div
      className={cn("relative shrink-0 rounded-[60px] bg-[#2a2b2f] p-[10px] font-satoshi", className)}
      style={{
        width: width + 20,
        boxShadow:
          "inset 0 0 0 1.5px rgb(255 255 255 / 0.14), 0 0 0 1px rgb(0 0 0 / 0.6), 0 40px 80px -24px rgb(0 0 0 / 0.75)",
        ...style,
      }}
      {...props}
    >
      <div
        className={cn("relative overflow-hidden rounded-[50px] bg-ui-canvas text-ui-text", screenClassName)}
        style={{ height }}
      >
        <div aria-hidden className="relative z-10 flex h-[50px] items-center justify-between px-8 pt-1 text-[15px] font-semibold">
          <span className="ui-figure">{time}</span>
          <span className="absolute top-[11px] left-1/2 h-[30px] w-[100px] -translate-x-1/2 rounded-full bg-black" />
          <span className="flex items-center gap-1.5">
            <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
              <rect x="0" y="7" width="3" height="4" rx="1" />
              <rect x="4.5" y="5" width="3" height="6" rx="1" />
              <rect x="9" y="2.5" width="3" height="8.5" rx="1" />
              <rect x="13.5" y="0" width="3" height="11" rx="1" />
            </svg>
            <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
              <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="currentColor" opacity="0.4" />
              <rect x="2" y="2" width="18" height="8" rx="2" fill="currentColor" />
              <rect x="23" y="4" width="1.5" height="4" rx="0.75" fill="currentColor" opacity="0.4" />
            </svg>
          </span>
        </div>
        <div className="absolute inset-x-0 top-[50px] bottom-0">{children}</div>
        <span aria-hidden className="absolute bottom-2 left-1/2 z-10 h-[5px] w-[120px] -translate-x-1/2 rounded-full bg-white/80" />
      </div>
    </div>
  );
}
