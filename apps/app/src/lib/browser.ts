"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

const noSubscribe = () => () => undefined;

function subscribeLocation(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** The page's full URL (fragment included), or null during server render. */
export function useHref(): string | null {
  // Re-read on client-side navigation too.
  usePathname();
  return useSyncExternalStore(
    subscribeLocation,
    () => window.location.href,
    () => null,
  );
}

/** This app's origin, or null during server render. */
export function useOrigin(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => null,
  );
}

/** A value only the browser knows, read once; `server` during server render. */
export function useBrowserValue<T>(read: () => T, server: T): T {
  return useSyncExternalStore(noSubscribe, read, () => server);
}
