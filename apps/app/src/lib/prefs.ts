"use client";

import { useSyncExternalStore } from "react";
import { currencyForLocale } from "./money";

/**
 * Per-device conveniences: the name on your send links and a local-currency
 * override. Nothing here is secret or load-bearing; every read survives
 * storage being unavailable.
 */

/** Which account the Home card shows (the Select account sheet sets it). */
export type HomeAccount = "dollar" | "later" | "boost";

type Prefs = { name: string; currency: string | null; homeAccount: HomeAccount };

const KEY = "polaris.prefs.v1";
const EVENT = "polaris:prefs";
const EMPTY: Prefs = { name: "", currency: null, homeAccount: "dollar" };

let cachedRaw: string | null | undefined;
let cached: Prefs = EMPTY;

function read(): Prefs {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    cached = {
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 40) : "",
      currency: typeof parsed.currency === "string" ? parsed.currency : null,
      homeAccount:
        parsed.homeAccount === "later" || parsed.homeAccount === "boost" ? parsed.homeAccount : "dollar",
    };
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, listener);
  };
}

/** The name the buyer chose on this device, outside React (the data layer). Empty during server render. */
export function prefsName(): string {
  return typeof window === "undefined" ? "" : read().name;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function setPrefs(patch: Partial<Prefs>): void {
  const next = { ...read(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    cachedRaw = undefined;
    cached = next;
  }
  window.dispatchEvent(new Event(EVENT));
}

const localeSnapshot = () => navigator.language || "en-US";

/** The viewer's locale, or null during server render. */
export function useLocale(): string | null {
  return useSyncExternalStore(
    () => () => undefined,
    localeSnapshot,
    () => null,
  );
}

/**
 * The viewer's local currency and locale: the override if set, otherwise the
 * currency the browser's language implies. Null for dollars (nothing to
 * convert) and during server render. The rate comes from lib/fx.ts.
 */
export function useLocalCurrency(): { currency: string; locale: string } | null {
  const locale = useLocale();
  const { currency: override } = usePrefs();
  if (!locale) return null;
  const currency = override ?? currencyForLocale(locale);
  if (currency === "USD") return null;
  return { currency, locale };
}
