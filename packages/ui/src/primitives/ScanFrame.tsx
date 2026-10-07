import type { HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export type ScanFrameProps = HTMLAttributes<HTMLDivElement>;

const CORNER = "absolute size-10 border-ui-lime";

/**
 * The camera well a QR scanner sits in: a 4:3 dark panel with four lime
 * corner marks. Put the `<video>` and whatever shows before the camera starts
 * inside it; the corners draw over them and never take a tap.
 *
 * ```tsx
 * <ScanFrame>
 *   <video className="absolute inset-0 size-full object-cover" />
 * </ScanFrame>
 * ```
 */
export function ScanFrame({ className, children, ...props }: ScanFrameProps) {
  return (
    <div className={cn("relative aspect-[4/3] w-full overflow-hidden rounded-ui-card bg-ui-candle-panel", className)} {...props}>
      {children}
      <div aria-hidden className="pointer-events-none absolute inset-7">
        <span className={cn(CORNER, "top-0 left-0 rounded-tl-[18px] border-t-[3px] border-l-[3px]")} />
        <span className={cn(CORNER, "top-0 right-0 rounded-tr-[18px] border-t-[3px] border-r-[3px]")} />
        <span className={cn(CORNER, "bottom-0 left-0 rounded-bl-[18px] border-b-[3px] border-l-[3px]")} />
        <span className={cn(CORNER, "right-0 bottom-0 rounded-br-[18px] border-r-[3px] border-b-[3px]")} />
      </div>
    </div>
  );
}
