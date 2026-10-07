"use client";

import { useSyncExternalStore } from "react";

let now = 0;
const read = () => {
  // Stable within a minute so React sees one snapshot per render pass.
  const current = Math.floor(Date.now() / 60_000) * 60_000;
  if (current !== now) now = current;
  return now;
};

/**
 * The current time on the client, null during server render. Anything that
 * prints a date uses it, so server and client HTML never disagree.
 */
export function useNow(): number | null {
  return useSyncExternalStore(
    () => () => undefined,
    read,
    () => null,
  );
}
