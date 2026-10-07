"use client";

import { X } from "lucide-react";
import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { IconButton } from "../primitives/Button";

export type OverlayKind = "sheet" | "drawer" | "dialog";

export type OverlayContextValue = {
  kind: OverlayKind;
  titleId: string;
  descriptionId: string;
  close: () => void;
  /** Sheets only: move to a snap point. */
  snapTo?: (snap: string | number) => void;
};

export const OverlayContext = createContext<OverlayContextValue | null>(null);

/** Inside a BottomSheet, Drawer or Dialog: close it, read which one it is. */
export function useOverlay(): OverlayContextValue {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error("useOverlay must be used inside a BottomSheet, Drawer or Dialog.");
  return ctx;
}

export type OverlayHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Left of the title (a back button, an avatar). */
  leading?: ReactNode;
  /** Right, before the close button. */
  action?: ReactNode;
  /** Hide the close button (a flow that must be finished). */
  hideClose?: boolean;
  /** Centre the title (iOS style); sheets default to centred. */
  align?: "start" | "center";
};

/**
 * The title row: title (and an optional line under it) with a round close
 * button. It names the overlay for screen readers.
 */
export function OverlayHeader({
  title,
  description,
  leading,
  action,
  hideClose = false,
  align,
  className,
  ...props
}: OverlayHeaderProps) {
  const { kind, titleId, descriptionId, close } = useOverlay();
  const centred = (align ?? (kind === "sheet" ? "center" : "start")) === "center";
  const closeButton = hideClose ? null : (
    <IconButton label="Close" icon={<X />} size="md" tone="surface" onClick={close} data-sheet-close="" />
  );
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 font-satoshi",
        kind === "sheet" ? "min-h-14 px-5 pt-1 pb-3" : "px-6 pt-6 pb-4",
        className,
      )}
      {...props}
    >
      {centred ? (
        <>
          <div className="flex w-11 shrink-0 justify-start">{leading}</div>
          <div className="min-w-0 flex-1 text-center">
            <h2 id={titleId} className="truncate text-[18px] leading-tight font-medium tracking-[-0.015em]">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 line-clamp-3 text-balance text-[13px] leading-snug text-ui-muted">
                {description}
              </p>
            ) : null}
          </div>
          <div className="flex w-11 shrink-0 items-center justify-end gap-2">
            {action}
            {closeButton}
          </div>
        </>
      ) : (
        <>
          {leading}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[20px] leading-tight font-medium tracking-[-0.02em]">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-[14px] text-ui-muted">
                {description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start">
            {action}
            {closeButton}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The scrolling content. In a sheet it scrolls without fighting the drag.
 * It takes focus (tabIndex 0) so a keyboard can scroll it even when nothing
 * inside is focusable; name it with `aria-label` when that helps.
 */
export function OverlayBody({ className, tabIndex = 0, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { kind } = useOverlay();
  return (
    <div
      data-sheet-scroll=""
      tabIndex={tabIndex}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain font-satoshi outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ui-focus",
        kind === "sheet" ? "touch-pan-y px-5 pb-[max(20px,env(safe-area-inset-bottom))]" : "px-6 pb-6",
        className,
      )}
      {...props}
    />
  );
}

/** Actions pinned to the bottom edge (above the home indicator in a sheet). */
export function OverlayFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { kind } = useOverlay();
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 font-satoshi",
        kind === "sheet"
          ? "border-t border-ui-hairline px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] [&>*]:flex-1"
          : "justify-end border-t border-ui-hairline px-6 py-4",
        className,
      )}
      {...props}
    />
  );
}
