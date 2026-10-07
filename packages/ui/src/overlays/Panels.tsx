"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useId, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/cn";
import { SHEET_QUERY, useFocusTrap, useInheritedTheme, useMediaQuery, useMounted, useScrollLock } from "../lib/hooks";
import { BottomSheet, type SnapPoint } from "./BottomSheet";
import { OverlayBody, OverlayContext, OverlayFooter, OverlayHeader } from "./parts";

type PanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Renders the standard header; or put <Drawer.Header> in children. */
  title?: ReactNode;
  description?: ReactNode;
  "aria-label"?: string;
  /** Escape and the backdrop close it. */
  dismissible?: boolean;
  theme?: "dark" | "light" | "ref-e";
  /** Snap points when it becomes a BottomSheet below 768px. */
  sheetSnapPoints?: SnapPoint[];
  /** Called once the close animation has finished and the panel has left the page. */
  onClosed?: () => void;
  className?: string;
  children?: ReactNode;
};

const PANEL_SPRING = { type: "spring", stiffness: 380, damping: 38, mass: 0.9 } as const;

function useDesktopLayer(open: boolean, onOpenChange: (o: boolean) => void, dismissible: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useScrollLock(open);
  useFocusTrap(ref, open, { onEscape: dismissible ? close : undefined });
  return { ref, close };
}

/* ── Drawer ──────────────────────────────────────────────────────────────── */

export type DrawerProps = PanelProps & {
  /** Panel width on desktop. */
  size?: "sm" | "md" | "lg";
};

const DRAWER_W = { sm: 400, md: 480, lg: 640 };

/**
 * A right-hand panel for details (a payment, a plan, a payout). Below 768px
 * it becomes a BottomSheet with the same content.
 *
 * ```tsx
 * <Drawer open={!!payment} onOpenChange={(o) => !o && setPayment(null)} title="Payment" description="pl_8f2k…">
 *   <Drawer.Body>…</Drawer.Body>
 *   <Drawer.Footer><Button variant="outline">Refund</Button></Drawer.Footer>
 * </Drawer>
 * ```
 */
export function Drawer({ size = "md", sheetSnapPoints = ["half", "full"], ...props }: DrawerProps) {
  const asSheet = useMediaQuery(SHEET_QUERY);
  if (asSheet) return <SheetFallback snapPoints={sheetSnapPoints} {...props} />;
  return <DrawerPanel size={size} {...props} />;
}

function DrawerPanel({
  open,
  onOpenChange,
  title,
  description,
  "aria-label": ariaLabel,
  dismissible = true,
  theme,
  size = "md",
  onClosed,
  className,
  children,
}: DrawerProps) {
  const mounted = useMounted();
  const reduced = useReducedMotion();
  const { ref, close } = useDesktopLayer(open, onOpenChange, dismissible);
  const layerTheme = useInheritedTheme(open, theme);
  const titleId = useId();
  const descriptionId = useId();
  const ctx = useMemo(() => ({ kind: "drawer" as const, titleId, descriptionId, close }), [titleId, descriptionId, close]);
  if (!mounted) return null;
  const labelled = Boolean(title) || !ariaLabel;
  return createPortal(
    <OverlayContext.Provider value={ctx}>
      <AnimatePresence onExitComplete={onClosed}>
        {open ? (
          <motion.div
            key="backdrop"
            aria-hidden
            className="fixed inset-0 z-[900] bg-ui-scrim backdrop-blur-[8px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            onClick={dismissible ? close : undefined}
          />
        ) : null}
        {open ? (
          <motion.div
            key="panel"
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelled ? titleId : undefined}
            aria-label={labelled ? undefined : ariaLabel}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            data-ui-layer=""
            data-theme={layerTheme}
            initial={reduced ? { opacity: 0 } : { x: "105%" }}
            animate={reduced ? { opacity: 1 } : { x: 0 }}
            exit={reduced ? { opacity: 0 } : { x: "105%", transition: { type: "spring", stiffness: 420, damping: 42 } }}
            transition={reduced ? { duration: 0.18 } : PANEL_SPRING}
            className={cn(
              "fixed top-3 right-3 bottom-3 z-[901] flex flex-col overflow-hidden rounded-ui-card bg-ui-surface-1 font-satoshi text-ui-text shadow-ui-pop outline-none",
              className,
            )}
            style={{ width: `min(${DRAWER_W[size]}px, calc(100vw - 24px))` }}
          >
            {title ? <OverlayHeader title={title} description={description} /> : null}
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </OverlayContext.Provider>,
    document.body,
  );
}

Drawer.Header = OverlayHeader;
Drawer.Body = OverlayBody;
Drawer.Footer = OverlayFooter;

/* ── Dialog ──────────────────────────────────────────────────────────────── */

export type DialogProps = PanelProps & {
  size?: "sm" | "md" | "lg";
};

const DIALOG_W = { sm: 400, md: 520, lg: 680 };

/**
 * A centred panel for create and edit flows (a new link, a new key, a
 * webhook). Below 768px it becomes a BottomSheet with the same content.
 *
 * ```tsx
 * <Dialog open={open} onOpenChange={setOpen} title="New payment link">
 *   <Dialog.Body>…form…</Dialog.Body>
 *   <Dialog.Footer><Button variant="ghost">Cancel</Button><Button variant="dark">Create link</Button></Dialog.Footer>
 * </Dialog>
 * ```
 */
export function Dialog({ size = "md", sheetSnapPoints, ...props }: DialogProps) {
  const asSheet = useMediaQuery(SHEET_QUERY);
  if (asSheet) return <SheetFallback snapPoints={sheetSnapPoints ?? (size === "sm" ? ["compact"] : ["full"])} {...props} />;
  return <DialogPanel size={size} {...props} />;
}

function DialogPanel({
  open,
  onOpenChange,
  title,
  description,
  "aria-label": ariaLabel,
  dismissible = true,
  theme,
  size = "md",
  onClosed,
  className,
  children,
}: DialogProps) {
  const mounted = useMounted();
  const reduced = useReducedMotion();
  const { ref, close } = useDesktopLayer(open, onOpenChange, dismissible);
  const layerTheme = useInheritedTheme(open, theme);
  const titleId = useId();
  const descriptionId = useId();
  const ctx = useMemo(() => ({ kind: "dialog" as const, titleId, descriptionId, close }), [titleId, descriptionId, close]);
  if (!mounted) return null;
  const labelled = Boolean(title) || !ariaLabel;
  return createPortal(
    <OverlayContext.Provider value={ctx}>
      <AnimatePresence onExitComplete={onClosed}>
        {open ? (
          <motion.div
            key="backdrop"
            aria-hidden
            className="fixed inset-0 z-[900] bg-ui-scrim backdrop-blur-[8px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={dismissible ? close : undefined}
          />
        ) : null}
        {open ? (
          <div key="frame" className="pointer-events-none fixed inset-0 z-[901] grid place-items-center p-6">
            <motion.div
              ref={ref}
              role="dialog"
              aria-modal="true"
              aria-labelledby={labelled ? titleId : undefined}
              aria-label={labelled ? undefined : ariaLabel}
              aria-describedby={description ? descriptionId : undefined}
              tabIndex={-1}
              data-ui-layer=""
              data-theme={layerTheme}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 10 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.16 } }}
              transition={reduced ? { duration: 0.18 } : { type: "spring", stiffness: 420, damping: 32 }}
              className={cn(
                "pointer-events-auto flex max-h-[calc(100dvh-48px)] w-full flex-col overflow-hidden rounded-ui-card bg-ui-surface-1 font-satoshi text-ui-text shadow-ui-pop outline-none",
                className,
              )}
              style={{ maxWidth: DIALOG_W[size] }}
            >
              {title ? <OverlayHeader title={title} description={description} /> : null}
              {children}
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </OverlayContext.Provider>,
    document.body,
  );
}

Dialog.Header = OverlayHeader;
Dialog.Body = OverlayBody;
Dialog.Footer = OverlayFooter;

/* ── Below 768px ─────────────────────────────────────────────────────────── */

function SheetFallback({
  open,
  onOpenChange,
  title,
  description,
  "aria-label": ariaLabel,
  dismissible = true,
  theme,
  snapPoints,
  onClosed,
  className,
  children,
}: PanelProps & { snapPoints: SnapPoint[] }) {
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      onClosed={onClosed}
      snapPoints={snapPoints}
      title={title}
      description={description}
      aria-label={ariaLabel}
      dismissible={dismissible}
      theme={theme}
      className={className}
    >
      {children}
    </BottomSheet>
  );
}
