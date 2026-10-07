/**
 * Turning a rate into the words under a dollar amount. Browser-safe: no viem,
 * no network, so the apps import it into client components
 * (`@polaris/fx/display`).
 *
 * The line reads "≈ ARS 161,241 · Chainlink rate, 3 min ago · indicative".
 * Buyers never see a chain, a feed or an address: "Chainlink rate" is the only
 * word about where the number comes from.
 */

import { CHAINS, type ChainKey } from "./feeds.ts";
import { FX_MAX_AGE_SECONDS } from "./limits.ts";
import type { FxLookup, FxRate } from "./service.ts";

export { FX_MAX_AGE_SECONDS };
export type { FxLookup, FxRate };

/** True while a rate updated at `updatedAt` (unix seconds) may still be shown. */
export function isFreshRate(updatedAt: number, nowMs: number, maxAgeSeconds: number = FX_MAX_AGE_SECONDS): boolean {
  return nowMs / 1000 - updatedAt <= maxAgeSeconds;
}

/** A dollar amount in base units (6 decimals) converted at `perUsd`. */
export function localAmount(micros: bigint, perUsd: number): number {
  return (Number(micros) / 1e6) * perUsd;
}

/**
 * "ARS 161,241" (en-US) or "ARS 161.241" (es-AR): the currency's code, never
 * its symbol, so pesos can't be mistaken for dollars ("$" is both). Whole
 * units from 1,000 up; below that the currency's usual decimals. Null when
 * the locale or currency is unusable, or for USD (nothing to convert).
 */
export function formatLocalAmount(micros: bigint, currency: string, perUsd: number, locale: string): string | null {
  if (currency === "USD" || !Number.isFinite(perUsd) || perUsd <= 0) return null;
  const value = localAmount(micros, perUsd);
  try {
    const usual = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    const digits = Math.abs(value) >= 1000 ? 0 : usual;
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "code",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return null;
  }
}

/** "just now", "3 min ago", "5 h ago": how old the rate is. */
export function rateAgeText(updatedAt: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - updatedAt));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

const STATUSES = new Set(["ok", "no-feed", "stale", "unavailable"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Checks an `/api/fx` response before the browser trusts it. Anything that
 * isn't a well-formed lookup comes back null, and the app shows no line.
 */
export function parseFxLookup(json: unknown): FxLookup | null {
  if (!isRecord(json) || typeof json.currency !== "string" || !STATUSES.has(json.status as string)) return null;
  const currency = json.currency;
  if (json.status !== "ok") return { currency, status: json.status as "no-feed" | "stale" | "unavailable", rate: null };
  const rate = json.rate;
  if (!isRecord(rate) || !isRecord(rate.source)) return null;
  const { perUsd, updatedAt, source } = rate;
  // The rate's own source limit; an older API without it gets the overall 26 h cap.
  const maxAgeSeconds =
    typeof rate.maxAgeSeconds === "number" && Number.isInteger(rate.maxAgeSeconds) && rate.maxAgeSeconds > 0
      ? Math.min(rate.maxAgeSeconds, FX_MAX_AGE_SECONDS)
      : FX_MAX_AGE_SECONDS;
  if (typeof perUsd !== "number" || !Number.isFinite(perUsd) || perUsd <= 0) return null;
  if (typeof updatedAt !== "number" || !Number.isInteger(updatedAt) || updatedAt <= 0) return null;
  const chain = source.chain as ChainKey;
  if (!(typeof chain === "string" && chain in CHAINS)) return null;
  if (typeof source.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(source.address)) return null;
  if (typeof source.pair !== "string" || typeof source.decimals !== "number" || typeof source.roundId !== "string") return null;
  const parsed: FxRate = {
    currency,
    perUsd,
    updatedAt,
    maxAgeSeconds,
    source: {
      chain,
      chainId: CHAINS[chain].id,
      address: source.address as `0x${string}`,
      pair: source.pair,
      decimals: source.decimals,
      roundId: source.roundId,
    },
  };
  return { currency, status: "ok", rate: parsed };
}
