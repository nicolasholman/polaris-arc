"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Subscribe to a media query. On the server (and the first client render)
 * it reports `serverValue`, so markup never mismatches.
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

/** Below 768px, Drawer and Dialog present as a BottomSheet. */
export const SHEET_QUERY = "(max-width: 767.98px)";

/** Controlled or uncontrolled state, the way native inputs behave. */
export function useControllable<T>({
  value,
  defaultValue,
  onChange,
}: {
  value?: T;
  defaultValue: T;
  onChange?: (value: T) => void;
}): [T, (next: T) => void] {
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const onChangeRef = useRef(onChange);
  useIsomorphicLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next);
      onChangeRef.current?.(next);
    },
    [controlled],
  );
  return [current, set];
}

/* ── Scroll lock ─────────────────────────────────────────────────────────── */

let lockCount = 0;
let saved: { overflow: string; paddingRight: string; overscroll: string } | null = null;

/** Lock page scroll while `active`, compensating for the scrollbar so nothing shifts. Nested locks stack. */
export function useScrollLock(active: boolean) {
  useIsomorphicLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (lockCount === 0) {
      const gap = window.innerWidth - root.clientWidth;
      saved = {
        overflow: root.style.overflow,
        paddingRight: root.style.paddingRight,
        overscroll: root.style.overscrollBehavior,
      };
      root.style.overflow = "hidden";
      root.style.overscrollBehavior = "none";
      if (gap > 0) root.style.paddingRight = `${gap}px`;
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0 && saved) {
        root.style.overflow = saved.overflow;
        root.style.paddingRight = saved.paddingRight;
        root.style.overscrollBehavior = saved.overscroll;
        saved = null;
      }
    };
  }, [active]);
}

/* ── Focus trap ──────────────────────────────────────────────────────────── */

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0,
  );
}

/**
 * Whether the last input was the keyboard. A layer opened by a tap or a click
 * (or in a fresh window, like a checkout popup) takes focus itself, so no
 * focus ring lands on its first button; one opened from the keyboard focuses
 * its first control.
 */
let keyboardLast = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (!e.metaKey && !e.altKey && !e.ctrlKey) keyboardLast = true;
  }, true);
  window.addEventListener("pointerdown", () => {
    keyboardLast = false;
  }, true);
}

/**
 * Keep Tab inside `ref` while `active`, focus the first field (or the
 * container) on open, close on Escape, and hand focus back to whatever had
 * it when the layer closes.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  { onEscape, initialFocus }: { onEscape?: () => void; initialFocus?: React.RefObject<HTMLElement | null> } = {},
) {
  const escapeRef = useRef(onEscape);
  useIsomorphicLayoutEffect(() => {
    escapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;

    const frame = requestAnimationFrame(() => {
      // On touch screens focusing a field would throw the keyboard up over the
      // sheet, and after a click a ring on the first button is noise, so the
      // layer itself takes focus (its title is read out).
      const self = window.matchMedia("(pointer: coarse)").matches || !keyboardLast;
      const target =
        initialFocus?.current ??
        node.querySelector<HTMLElement>("[data-autofocus]") ??
        (self
          ? node
          : // The first real control; not the close button or a scroll area
            // (focusable only so a keyboard can scroll it).
            (focusables(node).find((el) => el.dataset.sheetClose === undefined && el.dataset.sheetScroll === undefined) ??
            node));
      target.focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Only the topmost layer answers Escape.
        const layers = document.querySelectorAll("[data-ui-layer]");
        if (layers[layers.length - 1] !== node) return;
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      // Stacked layers (a confirm sheet over a checkout): only the top one keeps focus.
      const layers = document.querySelectorAll("[data-ui-layer]");
      if (node.hasAttribute("data-ui-layer") && layers[layers.length - 1] !== node) return;
      const items = focusables(node);
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !node.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !node.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      // Hand focus back once the page behind is interactive again (a sheet
      // keeps its stage inert until its exit animation ends).
      let tries = 0;
      const restore = () => {
        if (!previous || typeof previous.focus !== "function" || !document.contains(previous)) return;
        if (previous.closest("[inert]") && tries++ < 90) {
          requestAnimationFrame(restore);
          return;
        }
        previous.focus({ preventScroll: true });
      };
      restore();
    };
  }, [active, ref, initialFocus]);
}

/** True after the first client render: portals need `document`. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * The theme a portalled layer should wear: the explicit one, or the theme
 * around whatever had focus when it opened (so a sheet opened from a light
 * panel is light).
 */
/** The library's themes (primitives/Card re-exports it). */
export type Theme = "dark" | "light" | "ref-e";

export function useInheritedTheme(open: boolean, explicit?: Theme): Theme | undefined {
  const [theme, setTheme] = useState<Theme | undefined>(explicit);
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    if (explicit) {
      setTheme(explicit);
      return;
    }
    const el = document.activeElement as HTMLElement | null;
    const scope = el?.closest("[data-theme]") ?? document.documentElement;
    // A scope can switch themes at 1024px (`data-theme-lg`, see styles.css).
    const wide = scope.getAttribute("data-theme-lg");
    const found = wide && window.matchMedia("(min-width: 1024px)").matches ? wide : scope.getAttribute("data-theme");
    setTheme(found === "light" || found === "dark" || found === "ref-e" ? found : undefined);
  }, [open, explicit]);
  return explicit ?? theme;
}

/* ── Reduced motion, hydration-safe ──────────────────────────────────────── */

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * Whether the person asked for reduced motion, reading `false` on the server
 * and while hydrating (so the first client render matches the server HTML),
 * and the real preference right after. Anything whose first render depends on
 * it (a chart's draw-in `initial`) should key its animated element on the
 * result, so it remounts in its final state when the preference arrives.
 * Motion's own `useReducedMotion` reads the preference during hydration,
 * which makes the server and client markup differ.
 */
export function useReducedMotionSafe(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}
