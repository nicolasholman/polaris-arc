import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../lib/cn";
import type { Theme } from "../primitives/Card";

export type AppFrameProps = HTMLAttributes<HTMLDivElement> & {
  /** Classes for the dark panel itself. */
  panelClassName?: string;
  /** Fill the viewport (a page root). Off for a framed preview inside a page. */
  fullHeight?: boolean;
  /** Scope the frame to a theme; it inherits the page's otherwise. */
  theme?: Theme;
  /**
   * Where the panel starts floating. `lg` (1024px, a 16px frame that grows
   * to 32px from 1280px) for an app; `xl` to float only from 1280px;
   * `always` for a preview that should float at any width (the gallery, a
   * hero visual).
   */
  floatFrom?: "lg" | "xl" | "always";
};

/**
 * Ref E's frame: the whole app is a dark rounded panel (#121418, a big soft
 * shadow) floating on the lime canvas. From 1024px it floats in 16px of lime
 * with 24px corners, from 1280px in 32px with 32px corners; below 1024px
 * the dark app is full bleed.
 *
 * ```tsx
 * <AppFrame>
 *   <TopNav … />
 *   <main>…</main>
 * </AppFrame>
 * ```
 */
export const AppFrame = forwardRef<HTMLDivElement, AppFrameProps>(function AppFrame(
  { panelClassName, fullHeight = true, theme, floatFrom = "lg", className, children, ...props },
  ref,
) {
  const always = floatFrom === "always";
  const fromLg = floatFrom === "lg";
  return (
    <div
      ref={ref}
      data-theme={theme}
      className={cn(
        "min-w-0 font-satoshi text-ui-text",
        always
          ? "bg-ui-frame p-4 sm:p-6 lg:p-8"
          : fromLg
            ? "bg-ui-canvas lg:bg-ui-frame lg:p-4 xl:p-8"
            : "bg-ui-canvas xl:bg-ui-frame xl:p-8",
        fullHeight && "min-h-dvh",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "relative bg-ui-canvas",
          always
            ? "rounded-[24px] shadow-ui-frame lg:rounded-ui-frame"
            : fromLg
              ? "lg:rounded-[24px] lg:shadow-ui-frame xl:rounded-ui-frame"
              : "xl:rounded-ui-frame xl:shadow-ui-frame",
          fullHeight &&
            (always
              ? "min-h-[calc(100dvh-64px)]"
              : fromLg
                ? "min-h-dvh lg:min-h-[calc(100dvh-32px)] xl:min-h-[calc(100dvh-64px)]"
                : "min-h-dvh xl:min-h-[calc(100dvh-64px)]"),
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
});
