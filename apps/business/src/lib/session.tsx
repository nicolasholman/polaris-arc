"use client";

import { toast } from "@polaris/ui";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "./auth-context";
import { createHttpData, errorMessage, type DashboardData } from "./data";
import { readiness, type Readiness } from "./features";
import { MerchantContext } from "./merchant-context";

/* ── The live data source, bound to the session ─────────────────────────── */

const LiveDataContext = createContext<DashboardData | null>(null);

/**
 * A 401 can arrive from any request; the provider below listens for it. Kept
 * outside React so the data source never closes over component state.
 */
const sessionEndedListeners = new Set<() => void>();
const announceSessionEnded = () => sessionEndedListeners.forEach((l) => l());
let ending = false;

/**
 * The dashboard's data source for the signed-in merchant. A 401 from the API
 * (the session ended or the token is no longer valid) signs out, says so in a
 * toast, and goes to /login, back to this page afterwards.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const { getAccessToken, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const source = useMemo<DashboardData>(
    () => createHttpData(getAccessToken, { onSessionEnded: announceSessionEnded }),
    [getAccessToken],
  );

  useEffect(() => {
    const onEnded = () => {
      if (ending) return;
      ending = true;
      toast({ id: "session-ended", title: "Your session ended. Sign in again.", tone: "info", duration: 6000 });
      void logout()
        .catch(() => undefined)
        .finally(() => {
          router.replace(pathname && pathname !== "/login" ? `/login?next=${encodeURIComponent(pathname)}` : "/login");
          setTimeout(() => (ending = false), 2000);
        });
    };
    sessionEndedListeners.add(onEnded);
    return () => {
      sessionEndedListeners.delete(onEnded);
    };
  }, [logout, router, pathname]);

  return <LiveDataContext.Provider value={source}>{children}</LiveDataContext.Provider>;
}

/** The source a page reads: the signed-in merchant's own data, from the API. */
export function useDashboardData(): DashboardData {
  const source = useContext(LiveDataContext);
  if (!source) throw new Error("useDashboardData must be used inside the DataProvider.");
  return source;
}

/* ── useQuery ───────────────────────────────────────────────────────────── */

export type QueryState<T> = {
  data: T | undefined;
  /** The last load's error, even when older data is still on screen. */
  error: string | null;
  /** First load, nothing to show yet. */
  loading: boolean;
  /** A reload is in flight with data on screen. */
  refreshing: boolean;
  /** Data is on screen, but the latest refresh failed: show it inline. */
  stale: boolean;
  /** When the data on screen was loaded. */
  updatedAt: number | null;
  reload: () => void;
  mutate: (update: (current: T | undefined) => T | undefined) => void;
};

/**
 * How often the money pages (Overview, Payments, Pay in 4, Payouts) read
 * again while the tab is visible: a payment should be on screen within
 * seconds of the chain (plan §8, "+$200.00, paid in full, 0.8 s later").
 * Every 3 s in `next dev` (pnpm demo:local), every 10 s in production.
 */
export const LIVE_REFRESH_MS = process.env.NODE_ENV === "development" ? 3_000 : 10_000;

/**
 * Load something from the page's data source, with loading, error, reload
 * and an optional refresh interval (only while the tab is visible, and at
 * once when the tab comes back into view). A failed
 * refresh keeps the older data and reports `stale`, so the page can say so
 * instead of silently showing old numbers.
 */
export function useQuery<T>(load: (data: DashboardData) => Promise<T>, options: { refreshMs?: number } = {}): QueryState<T> {
  const source = useDashboardData();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // A different source (a new session): start over.
  const [seenSource, setSeenSource] = useState(source);
  if (seenSource !== source) {
    setSeenSource(source);
    setData(undefined);
    setError(null);
    setInFlight(true);
  }

  useEffect(() => {
    let cancelled = false;
    loadRef
      .current(source)
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
        setUpdatedAt(Date.now());
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setInFlight(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, nonce]);

  useEffect(() => {
    if (!options.refreshMs) return;
    const again = () => {
      if (document.visibilityState !== "visible") return;
      setInFlight(true);
      setNonce((n) => n + 1);
    };
    const id = setInterval(again, options.refreshMs);
    // Back on the tab (or the window): read now rather than on the next tick.
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [options.refreshMs]);

  const reload = useCallback(() => {
    setInFlight(true);
    setNonce((n) => n + 1);
  }, []);
  const mutate = useCallback((update: (current: T | undefined) => T | undefined) => setData(update), []);

  return {
    data,
    error,
    loading: inFlight && data === undefined && !error,
    refreshing: inFlight && data !== undefined,
    stale: Boolean(error) && data !== undefined,
    updatedAt,
    reload,
    mutate,
  };
}

/**
 * Whether withdraw, automatic payouts, links and registration can work now,
 * from what the server is connected to. Each value is null when ready,
 * otherwise the reason to show beside the control.
 */
export function useReadiness(): Readiness {
  const ctx = useContext(MerchantContext);
  const capabilities = ctx?.capabilities;
  const failed = Boolean(ctx?.capabilitiesError);
  return useMemo(() => readiness(capabilities, failed), [capabilities, failed]);
}
