"use client";

import { useIsDesktop } from "../trade/Adaptive";
import { BottomSheet, type BottomSheetProps } from "./BottomSheet";
import { Dialog, Drawer } from "./Panels";

export type AdaptiveSheetProps = BottomSheetProps & {
  /** From 1024px: a centred Dialog (a confirm, a short flow) or a right-hand Drawer (details). */
  desktop?: "dialog" | "drawer";
  /** The Dialog's or Drawer's width from 1024px. */
  desktopSize?: "sm" | "md" | "lg";
  /** Classes for the Dialog or Drawer only (the sheet keeps `className`). */
  desktopClassName?: string;
};

/**
 * A BottomSheet on a phone and a Dialog or Drawer on a desktop, with the same
 * content: `Sheet.Body` and `Sheet.Footer` work in all three. Below 1024px
 * it is exactly the BottomSheet it is given (every prop passed through), so a
 * phone layout doesn't change; from 1024px (or inside `<Adaptive>`'s desktop
 * branch) snap points and `maxWidth` are ignored.
 *
 * ```tsx
 * <AdaptiveSheet open={open} onOpenChange={setOpen} snapPoints={["fit"]} maxWidth={440} aria-label="Confirm" desktop="dialog" desktopSize="sm">
 *   <Sheet.Body>…</Sheet.Body>
 * </AdaptiveSheet>
 * ```
 */
export function AdaptiveSheet({ desktop = "dialog", desktopSize, desktopClassName, ...props }: AdaptiveSheetProps) {
  const wide = useIsDesktop();
  if (!wide) return <BottomSheet {...props} />;
  const { open, onOpenChange, onClosed, title, description, dismissible, theme, children } = props;
  const shared = {
    open,
    onOpenChange,
    onClosed,
    title,
    description,
    "aria-label": props["aria-label"],
    dismissible,
    theme,
    className: desktopClassName,
    children,
  };
  return desktop === "drawer" ? <Drawer size={desktopSize ?? "md"} {...shared} /> : <Dialog size={desktopSize ?? "sm"} {...shared} />;
}
