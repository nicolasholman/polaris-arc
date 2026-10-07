"use client";

import { type FxRate, isFreshRate, parseFxLookup } from "@polaris/fx/display";
import { useEffect, useSyncExternalStore } from "react";

/**
 * The Chainlink rate for the viewer's local currency, from this app's own
 * `/api/fx` (the server reads the feeds; the browser never talks to a chain
 * for this). One request per currency per five minutes for the whole tab,
 * however many amounts are on screen. Null until it arrives, and whenever
 * there is no fresh rate: then no local amount is shown at all.
 */

const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000;

type Entry = { rate: FxRate | null; fetchedAt: number; loading: boolean };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load(currency: string): void {
  const entry = entries.get(currency);
  const now = Date.now();
  if (entry && (entry.loading || now - entry.fetchedAt < (entry.rate ? REFRESH_MS : RETRY_MS))) return;
  entries.set(currency, { rate: entry?.rate ?? null, fetchedAt: entry?.fetchedAt ?? 0, loading: true });
  fetch(`/api/fx?currency=${encodeURIComponent(currency)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown) => {
      const lookup = parseFxLookup(json);
      const rate = lookup?.status === "ok" && lookup.currency === currency ? lookup.rate : null;
      entries.set(currency, { rate, fetchedAt: Date.now(), loading: false });
    })
    .catch(() => {
      // Keep the last good rate (it still has to pass the 26 h check to show).
      entries.set(currency, { rate: entry?.rate ?? null, fetchedAt: Date.now(), loading: false });
    })
    .finally(emit);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* A clock for "3 min ago": ticks every 30 s while something shows a rate. */
let clock = 0;
const clockListeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  timer ??= setInterval(() => {
    clock = Date.now();
    clockListeners.forEach((l) => l());
  }, 30_000);
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const readClock = () => (clock ||= Date.now());

/** Now, in milliseconds, updated every 30 s; null during server render. */
export function useTicker(): number | null {
  return useSyncExternalStore(subscribeClock, readClock, () => null);
}

/** The fresh Chainlink rate for `currency`, or null (none, too old, not loaded yet, or USD). */
export function useFxRate(currency: string | null): FxRate | null {
  const now = useTicker();
  const rate = useSyncExternalStore(
    subscribe,
    () => (currency ? (entries.get(currency)?.rate ?? null) : null),
    () => null,
  );
  // `now` changes every 30 s, which also re-asks once the five minutes are up.
  useEffect(() => {
    if (currency && currency !== "USD") load(currency);
  }, [currency, now]);
  // Each rate carries its own feed's limit (a Monad feed's is 14 min, an Ethereum one's 26 h).
  if (!rate || now === null || !isFreshRate(rate.updatedAt, now, rate.maxAgeSeconds)) return null;
  return rate;
}
