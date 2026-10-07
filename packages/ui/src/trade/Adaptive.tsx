"use client";

import { createContext, useContext, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { useMediaQuery, useMounted } from "../lib/hooks";

/**
 * Where an app with a phone layout and a desktop layout switches: 1024px,
 * Tailwind's `lg`, the width ref E's frame starts floating at.
 */
export const DESKTOP_QUERY = "(min-width: 1024px)";

export type AdaptiveMode = "phone" | "desktop";

type AdaptiveState = {
  mode: AdaptiveMode;
  /**
   * False on the server and while hydrating, when both layouts are in the
   * page (CSS shows the right one). Anything that must exist once, a route
   * sheet say, waits for it.
   */
  settled: boolean;
};

const AdaptiveContext = createContext<AdaptiveState | null>(null);

export type AdaptiveProps = {
  /** Below 1024px. */
  phone: ReactNode;
  /** From 1024px. */
  desktop: ReactNode;
};

/**
 * Two layouts for one route: the phone's and the desktop's. The server
 * renders both and CSS shows the one that fits, so there is no flash and no
 * hydration mismatch; right after hydration only the matching one stays
 * mounted (the other goes without remounting it), and a resize past 1024px
 * swaps them. Inside, `useAdaptive()` says which one a component is in.
 *
 * ```tsx
 * <Adaptive phone={<>{children}<TabBar /></>} desktop={<DesktopShell>{children}</DesktopShell>} />
 * ```
 */
export function Adaptive({ phone, desktop }: AdaptiveProps) {
  const mounted = useMounted();
  const wide = useMediaQuery(DESKTOP_QUERY);
  const showPhone = !mounted || !wide;
  const showDesktop = !mounted || wide;
  return (
    <>
      {showPhone ? (
        <div data-adaptive="phone" className={cn("contents", !mounted && "lg:hidden")}>
          <AdaptiveContext.Provider value={{ mode: "phone", settled: mounted }}>{phone}</AdaptiveContext.Provider>
        </div>
      ) : null}
      {showDesktop ? (
        <div data-adaptive="desktop" className={mounted ? "contents" : "hidden lg:contents"}>
          <AdaptiveContext.Provider value={{ mode: "desktop", settled: mounted }}>{desktop}</AdaptiveContext.Provider>
        </div>
      ) : null}
    </>
  );
}

/**
 * Which layout this component is in: the nearest `<Adaptive>`'s branch, or
 * the viewport's width outside one (settled once hydrated).
 */
export function useAdaptive(): AdaptiveState {
  const ctx = useContext(AdaptiveContext);
  const mounted = useMounted();
  const wide = useMediaQuery(DESKTOP_QUERY);
  return ctx ?? { mode: wide ? "desktop" : "phone", settled: mounted };
}

/** From 1024px (or inside `<Adaptive>`'s desktop branch). */
export function useIsDesktop(): boolean {
  return useAdaptive().mode === "desktop";
}
