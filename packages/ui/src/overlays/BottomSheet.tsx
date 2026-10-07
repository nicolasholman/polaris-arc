"use client";

import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/cn";
import { useFocusTrap, useInheritedTheme, useIsomorphicLayoutEffect, useMounted, useScrollLock } from "../lib/hooks";
import { OverlayBody, OverlayContext, OverlayFooter, OverlayHeader } from "./parts";

/* ── Snap points ─────────────────────────────────────────────────────────── */

/**
 * `compact`, `half` and `full` are fixed shares of the screen, a number is px,
 * and `fit` hugs the content (a Face ID confirm, a short form), up to full.
 */
export type SnapPoint = "compact" | "half" | "full" | "fit" | number;

const OPEN_SPRING = { type: "spring", stiffness: 360, damping: 36, mass: 0.9 } as const;
const SNAP_SPRING = { type: "spring", stiffness: 420, damping: 40 } as const;
const REDUCED = { duration: 0.18, ease: "easeOut" } as const;

function readSafeTop(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

function snapHeight(snap: SnapPoint, vh: number, safeTop: number, fit = 0): number {
  const full = vh - safeTop - 24;
  if (typeof snap === "number") return Math.min(snap, full);
  if (snap === "full") return full;
  if (snap === "half") return Math.min(full, Math.round(vh * 0.6));
  if (snap === "fit" && fit > 0) return Math.min(full, Math.ceil(fit));
  return Math.min(full, Math.round(Math.min(vh * 0.46, 380)));
}

/** A scroll area's content height (its own box may be stretched taller). */
function scrollContentHeight(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const pt = parseFloat(style.paddingTop) || 0;
  const pb = parseFloat(style.paddingBottom) || 0;
  const kids = Array.from(el.children) as HTMLElement[];
  if (!kids.length) return pt + pb;
  const top = el.getBoundingClientRect().top;
  let bottom = top + pt;
  for (const k of kids) bottom = Math.max(bottom, k.getBoundingClientRect().bottom);
  return bottom - top + el.scrollTop + pb;
}

/** The height the sheet's column needs to show everything without scrolling. */
function naturalHeight(column: HTMLElement): number {
  let h = 0;
  for (const child of Array.from(column.children) as HTMLElement[]) {
    const scroll = child.hasAttribute("data-sheet-scroll") ? child : child.querySelector<HTMLElement>("[data-sheet-scroll]");
    h += scroll ? child.offsetHeight - scroll.clientHeight + scrollContentHeight(scroll) : child.offsetHeight;
  }
  return h;
}

/**
 * The stack positions of the sheets on screen, including any still animating
 * out. A sheet takes the slot above the highest one still here, so it sits
 * above every sheet it opened over, backdrop and all, even when the sheet
 * below was swapped for another mid-flight (a count would hand out a slot
 * already taken).
 */
const liveDepths = new Set<number>();

/**
 * Whether the sheet a sheet sits inside is open. A sheet rendered inside
 * another (a Face ID confirm inside a checkout) closes with it, so it never
 * outlives the sheet it belongs to.
 */
const ParentSheetContext = createContext<boolean | null>(null);

function rubber(overshoot: number): number {
  return -Math.sqrt(Math.max(0, overshoot)) * 4;
}

/* ── SheetStage ──────────────────────────────────────────────────────────── */

type StageContextValue = {
  attach: (progress: MotionValue<number>) => () => void;
};

const StageContext = createContext<StageContextValue | null>(null);

export type SheetStageProps = HTMLAttributes<HTMLDivElement> & {
  /** How far the page behind shrinks (iOS uses about 0.96). */
  scale?: number;
};

/**
 * Wrap the app (or the page) in this and every open BottomSheet pushes it
 * back like iOS: it scales to 0.96, gains rounded corners and goes inert.
 *
 * ```tsx
 * <SheetStage className="min-h-dvh">
 *   <App />
 * </SheetStage>
 * ```
 */
export function SheetStage({ scale = 0.96, className, style, children, ...props }: SheetStageProps) {
  const progress = useMotionValue(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ top: 0, bottom: 0, origin: 0, safe: 0 });
  const [open, setOpen] = useState(0);
  const reduced = useReducedMotion();
  // Every sheet pushing the stage back right now. Stacked sheets (a Face ID
  // confirm over a checkout) keep it back until the last one has gone.
  const sheets = useRef(new Set<MotionValue<number>>());

  const attach = useCallback(
    (sheetProgress: MotionValue<number>) => {
      const el = stageRef.current;
      // Measure only while nothing is open: once scaled, the rect is the scaled one.
      if (el && sheets.current.size === 0) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const top = Math.max(0, -r.top);
        setFrame({ top, bottom: Math.max(0, r.height - top - vh), origin: top, safe: readSafeTop() });
      }
      sheets.current.add(sheetProgress);
      const update = () => {
        let max = 0;
        for (const p of sheets.current) max = Math.max(max, p.get());
        progress.set(max);
      };
      setOpen((n) => n + 1);
      const unsub = sheetProgress.on("change", update);
      update();
      return () => {
        unsub();
        sheets.current.delete(sheetProgress);
        update();
        setOpen((n) => Math.max(0, n - 1));
      };
    },
    [progress],
  );

  const s = useTransform(progress, [0, 1], [1, reduced ? 1 : scale]);
  const y = useTransform(progress, [0, 1], [0, reduced ? 0 : frame.safe + 10]);
  const clip = useTransform(progress, (p) =>
    p <= 0.001 || reduced ? "none" : `inset(${frame.top}px 0px ${frame.bottom}px 0px round ${Math.round(28 * p)}px)`,
  );
  const shade = useTransform(progress, [0, 1], [0, 1]);

  const value = useMemo(() => ({ attach }), [attach]);

  return (
    <StageContext.Provider value={value}>
      {open > 0 ? (
        <motion.div aria-hidden className="pointer-events-none fixed inset-0 z-0 bg-black" style={{ opacity: shade }} />
      ) : null}
      <motion.div
        ref={stageRef}
        inert={open > 0 ? true : undefined}
        className={cn("relative z-[1] bg-ui-canvas", className)}
        style={{
          ...style,
          scale: s,
          y,
          clipPath: clip,
          transformOrigin: `50% ${frame.origin}px`,
        }}
        {...(props as Record<string, unknown>)}
      >
        {children}
      </motion.div>
    </StageContext.Provider>
  );
}

/* ── BottomSheet ─────────────────────────────────────────────────────────── */

export type BottomSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Heights it rests at, from lowest to highest. Numbers are px. */
  snapPoints?: SnapPoint[];
  /** Where it opens. Defaults to the first snap point. */
  defaultSnap?: SnapPoint;
  /** Called when it settles on a snap point. */
  onSnapChange?: (snap: SnapPoint) => void;
  /** Called once the close animation has finished and the sheet has left the page. */
  onClosed?: () => void;
  /** Swipe down, the backdrop and Escape close it. */
  dismissible?: boolean;
  /** A title renders the standard header; or put <Sheet.Header> in children. */
  title?: ReactNode;
  description?: ReactNode;
  /** When there is no visible title. */
  "aria-label"?: string;
  /** Scope the sheet to a theme (it inherits the page's otherwise). */
  theme?: "dark" | "light" | "ref-e";
  /** Widest it gets on a large screen. */
  maxWidth?: number;
  className?: string;
  children?: ReactNode;
};

/**
 * The sheet everything you *do* slides up in. Drag the handle or header (or
 * the content, once it is scrolled to the top) between snap points; a fast
 * or long swipe down closes it. Springs in and out over a dimmed, blurred
 * backdrop, and pushes a <SheetStage> back. aria-modal, focus trap, Escape,
 * scroll lock and safe areas; reduced motion fades instead of sliding.
 *
 * ```tsx
 * <BottomSheet open={open} onOpenChange={setOpen} snapPoints={["half", "full"]} title="Plan">
 *   <Sheet.Body>…</Sheet.Body>
 *   <Sheet.Footer><Button variant="lime">Pay early</Button></Sheet.Footer>
 * </BottomSheet>
 * ```
 */
export function BottomSheet({
  open: openProp,
  onOpenChange,
  snapPoints = ["half"],
  defaultSnap,
  onSnapChange,
  onClosed,
  dismissible = true,
  title,
  description,
  "aria-label": ariaLabel,
  theme,
  maxWidth = 640,
  className,
  children,
}: BottomSheetProps) {
  const parentOpen = useContext(ParentSheetContext);
  const open = openProp && (parentOpen ?? true);
  const mounted = useMounted();
  const [present, setPresent] = useState(open);
  const [vh, setVh] = useState(0);
  const [safeTop, setSafeTop] = useState(0);
  const reduced = useReducedMotion() ?? false;
  const stage = useContext(StageContext);
  const layerTheme = useInheritedTheme(open, theme);

  const sheetRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(onClosed);
  useEffect(() => {
    closedRef.current = onClosed;
  });
  const titleId = useId();
  const descriptionId = useId();

  // `fit`: the content's own height, measured while the sheet is on screen.
  const columnRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const fits = snapPoints.includes("fit");
  useIsomorphicLayoutEffect(() => {
    const column = columnRef.current;
    if (!fits || !present || !column) return;
    const measure = () => setFit(naturalHeight(column));
    measure();
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      for (const child of Array.from(column.children)) {
        ro.observe(child);
        const scroll = child.hasAttribute("data-sheet-scroll") ? child : child.querySelector("[data-sheet-scroll]");
        if (scroll) for (const k of Array.from(scroll.children)) ro.observe(k);
      }
    };
    watch();
    const mo = new MutationObserver(() => {
      watch();
      measure();
    });
    mo.observe(column, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [fits, present, mounted]);

  const heights = useMemo(
    () => (vh ? snapPoints.map((s) => snapHeight(s, vh, safeTop, fit)).sort((a, b) => a - b) : []),
    [snapPoints, vh, safeTop, fit],
  );
  const H = heights.length ? heights[heights.length - 1]! : 0;
  const offsets = heights.map((h) => H - h); // translateY at rest, highest snap = 0
  const lowest = offsets.length ? offsets[0]! : 0;
  const closedY = H + 24;

  const y = useMotionValue(10000);
  const fade = useMotionValue(reduced ? 0 : 1);
  const progress = useTransform(y, (v) => (H ? Math.max(0, Math.min(1, 1 - (v - lowest) / (closedY - lowest))) : 0));
  const innerHeight = useTransform(y, (v) => Math.max(0, H - Math.max(0, Math.min(v, lowest))));
  const backdrop = useTransform([progress, fade], ([p, f]) => (p as number) * (f as number));
  const [snapIndex, setSnapIndex] = useState(0);

  const snapPointsKey = snapPoints.join(",");
  const initialIndex = useMemo(() => {
    if (defaultSnap === undefined) return 0;
    const target = vh ? snapHeight(defaultSnap, vh, safeTop, fit) : 0;
    const i = heights.findIndex((h) => h === target);
    return i < 0 ? 0 : i;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSnap, heights, snapPointsKey]);

  // Measure the viewport when opening and on resize.
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      setVh(window.innerHeight);
      setSafeTop(readSafeTop());
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (open) setPresent(true);
  }, [open]);

  const settle = useCallback(
    (index: number, velocity = 0) => {
      const target = offsets[index];
      if (target === undefined) return;
      setSnapIndex(index);
      onSnapChange?.(snapPoints.slice().sort((a, b) => snapHeight(a, vh, safeTop, fit) - snapHeight(b, vh, safeTop, fit))[index]!);
      if (reduced) animate(y, target, REDUCED);
      else animate(y, target, { ...SNAP_SPRING, velocity: velocity * 1000 });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [offsets.join(","), reduced, vh, safeTop, fit, snapPointsKey],
  );

  // Open and close.
  useEffect(() => {
    if (!present || !H) return;
    if (open) {
      const start = initialIndex;
      setSnapIndex(start);
      if (reduced) {
        y.set(offsets[start]!);
        fade.set(0);
        const c = animate(fade, 1, REDUCED);
        return () => c.stop();
      }
      fade.set(1);
      if (y.get() > closedY) y.set(closedY);
      const c = animate(y, offsets[start]!, OPEN_SPRING);
      return () => c.stop();
    }
    const done = () => {
      setPresent(false);
      closedRef.current?.();
    };
    const c = reduced
      ? animate(fade, 0, { ...REDUCED, onComplete: done })
      : animate(y, closedY, { type: "spring", stiffness: 380, damping: 40, restDelta: 1, onComplete: done });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, present, H]);

  // Keep the resting position right when the viewport changes.
  useEffect(() => {
    if (open && present && H && y.get() < closedY - 1) y.set(offsets[snapIndex] ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [H]);

  // Stack over any sheet already open: its own backdrop dims the one below.
  const [depth, setDepth] = useState(0);
  useIsomorphicLayoutEffect(() => {
    if (!present) return;
    const d = liveDepths.size ? Math.max(...liveDepths) + 1 : 0;
    liveDepths.add(d);
    setDepth(d);
    return () => {
      liveDepths.delete(d);
    };
  }, [present]);

  // Push the stage back.
  useEffect(() => {
    if (!present || !stage) return;
    return stage.attach(progress);
  }, [present, stage, progress]);

  useScrollLock(present);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useFocusTrap(sheetRef, present && open, { onEscape: dismissible ? close : undefined });

  /* ── Dragging ── */

  const drag = useRef<{
    startY: number;
    startOffset: number;
    samples: { t: number; y: number }[];
    pointerId?: number;
  } | null>(null);

  // Never leave the page unselectable if the sheet goes mid-drag.
  useEffect(
    () => () => {
      if (drag.current) document.documentElement.style.userSelect = "";
    },
    [],
  );

  const begin = (clientY: number, pointerId?: number) => {
    drag.current = { startY: clientY, startOffset: y.get(), samples: [{ t: performance.now(), y: clientY }], pointerId };
    y.stop();
    // A mouse drag on the title must move the sheet, not select its text.
    document.documentElement.style.userSelect = "none";
    window.getSelection()?.removeAllRanges();
  };

  const move = (clientY: number) => {
    const d = drag.current;
    if (!d) return;
    let next = d.startOffset + (clientY - d.startY);
    if (next < 0) next = rubber(-next);
    if (!dismissible && next > lowest) next = lowest + Math.sqrt(next - lowest) * 4;
    y.set(next);
    d.samples.push({ t: performance.now(), y: clientY });
    if (d.samples.length > 6) d.samples.shift();
  };

  const release = () => {
    const d = drag.current;
    drag.current = null;
    document.documentElement.style.userSelect = "";
    if (!d) return;
    const s = d.samples;
    const a = s[0]!;
    const b = s[s.length - 1]!;
    const dt = Math.max(1, b.t - a.t);
    const recent = performance.now() - b.t < 80;
    const v = recent ? (b.y - a.y) / dt : 0; // px/ms, positive = down
    const current = y.get();
    const projected = current + v * 180;
    if (dismissible && (v > 1.1 || projected > lowest + (closedY - lowest) * 0.45)) {
      close();
      return;
    }
    let best = 0;
    offsets.forEach((o, i) => {
      if (Math.abs(o - projected) < Math.abs(offsets[best]! - projected)) best = i;
    });
    settle(best, v);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-sheet-scroll]")) return; // the content handles itself
    if (target.closest("button, a, input, textarea, select, [role=slider], [data-no-drag]")) return;
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    begin(e.clientY, e.pointerId);
  };

  // Touch in the scroll area: drag the sheet when the content is at its top
  // and the finger moves down, or when the sheet can still grow and the
  // finger moves up; otherwise let the content scroll natively.
  useEffect(() => {
    const el = sheetRef.current;
    if (!present || !el) return;
    let mode: "undecided" | "sheet" | "scroll" = "undecided";
    let startY = 0;
    let scroller: HTMLElement | null = null;
    const onStart = (e: TouchEvent) => {
      scroller = (e.target as HTMLElement).closest<HTMLElement>("[data-sheet-scroll]");
      mode = scroller ? "undecided" : "scroll";
      startY = e.touches[0]!.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (mode === "scroll" || !scroller) return;
      const cy = e.touches[0]!.clientY;
      const dy = cy - startY;
      if (mode === "undecided") {
        if (Math.abs(dy) < 5) return;
        const atTop = scroller.scrollTop <= 0;
        const canGrow = y.get() > 0.5;
        mode = (dy > 0 && atTop) || (dy < 0 && canGrow) ? "sheet" : "scroll";
        if (mode === "sheet") begin(cy);
        else return;
      }
      if (e.cancelable) e.preventDefault();
      move(cy);
    };
    const onEnd = () => {
      if (mode === "sheet") release();
      mode = "undecided";
      scroller = null;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, H, lowest, dismissible]);

  const ctx = useMemo(
    () => ({
      kind: "sheet" as const,
      titleId,
      descriptionId,
      close,
      snapTo: (snap: string | number) => {
        const h = snapHeight(snap as SnapPoint, vh, safeTop, fit);
        const i = heights.findIndex((x) => x === h);
        if (i >= 0) settle(i);
      },
    }),
    [titleId, descriptionId, close, vh, safeTop, fit, heights, settle],
  );

  if (!mounted || !present) return null;

  const labelled = Boolean(title) || !ariaLabel;
  return createPortal(
    <OverlayContext.Provider value={ctx}>
      <motion.div
        aria-hidden
        className="fixed inset-0 bg-ui-scrim backdrop-blur-[8px]"
        // On its way out it no longer takes taps: nothing in it can still run.
        style={{ opacity: backdrop, zIndex: 900 + depth * 2, pointerEvents: open ? undefined : "none" }}
        onClick={dismissible ? close : undefined}
      />
      <motion.div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelled ? titleId : undefined}
        aria-label={labelled ? undefined : ariaLabel}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-ui-layer=""
        data-theme={layerTheme}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => drag.current?.pointerId === e.pointerId && move(e.clientY)}
        onPointerUp={(e) => drag.current?.pointerId === e.pointerId && release()}
        onPointerCancel={(e) => drag.current?.pointerId === e.pointerId && release()}
        className={cn(
          "fixed inset-x-0 bottom-0 mx-auto touch-none rounded-t-ui-sheet bg-ui-surface-1 font-satoshi text-ui-text shadow-[0_-12px_40px_rgb(0_0_0/0.25)] outline-none",
          className,
        )}
        style={{ height: H, maxWidth, y, opacity: fade, zIndex: 901 + depth * 2, pointerEvents: open ? undefined : "none" }}
      >
        {/* Fills the gap under the sheet when it is pulled past its top snap. */}
        <div aria-hidden className="absolute inset-x-0 top-full h-[120px] bg-ui-surface-1" />
        <motion.div ref={columnRef} className="flex flex-col overflow-hidden rounded-t-ui-sheet" style={{ height: innerHeight }}>
          <div className="flex shrink-0 cursor-grab justify-center pt-2 pb-1.5 active:cursor-grabbing">
            <span aria-hidden className="h-[5px] w-10 rounded-full bg-ui-text/20" />
          </div>
          {title ? <OverlayHeader title={title} description={description} /> : null}
          <ParentSheetContext.Provider value={open}>{children}</ParentSheetContext.Provider>
        </motion.div>
      </motion.div>
    </OverlayContext.Provider>,
    document.body,
  );
}

/**
 * The parts every overlay shares: `Sheet.Header` (title + close),
 * `Sheet.Body` (scrolls) and `Sheet.Footer` (actions, above the home bar).
 * Drawer and Dialog export the same parts.
 */
export const Sheet = {
  Header: OverlayHeader,
  Body: OverlayBody,
  Footer: OverlayFooter,
};
