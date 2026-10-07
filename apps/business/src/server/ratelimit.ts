import "server-only";

import { HttpError } from "./http";

/**
 * Token buckets, in memory, per key (an IP, an API key, a signing account).
 *
 * The relayer pays gas for every request it accepts, so it must not be a free
 * faucet for spam: each bucket refills at `perMinute` and holds at most
 * `burst`. Per-process: behind several instances the effective limit is
 * multiplied, which is acceptable for abuse control (money is protected by
 * signatures, not by this).
 *
 * At most MAX_BUCKETS keys are kept. When a new key would exceed that, the
 * least recently used bucket is dropped (a Map iterates in insertion order,
 * and every use moves its key to the end), so churning through fresh keys
 * can only ever evict idle buckets, never reset everyone's.
 */

type Bucket = { tokens: number; updatedMs: number };

export type Limit = { name: string; perMinute: number; burst: number };

export const LIMITS = {
  relayPerIp: { name: "relay-ip", perMinute: 30, burst: 15 },
  relayPerSigner: { name: "relay-signer", perMinute: 12, burst: 6 },
  /** A day's relays for one account: 100, refilling over 24 hours. */
  relayPerSignerDaily: { name: "relay-signer-day", perMinute: 100 / 1440, burst: 100 },
  /** Every transfer and send by link, from anyone (no merchant checkout behind them): the relayer's circuit breaker. */
  relayOpenGlobal: { name: "relay-open-global", perMinute: 60, burst: 120 },
  publicPerIp: { name: "public-ip", perMinute: 240, burst: 60 },
  /** GET /api/health: every open dashboard reads it; cheap, and never shared with checkout reads. */
  healthPerIp: { name: "health-ip", perMinute: 1200, burst: 300 },
  apiPerKey: { name: "api-key", perMinute: 300, burst: 100 },
  onboardPerMerchant: { name: "onboard", perMinute: 6, burst: 3 },
  /** Underwriting is once per account, and the CRE trigger runs once per 30 s for everyone: a few tries an hour, a few a day. */
  underwritePerAccount: { name: "underwrite", perMinute: 4 / 60, burst: 2 },
  underwritePerAccountDaily: { name: "underwrite-day", perMinute: 6 / 1440, burst: 6 },
  /** Opening a payment link makes a session (its price is pinned on chain when someone pays it). */
  linkOpen: { name: "link-open", perMinute: 20, burst: 10 },
  /** Dashboard writes (POST, PATCH, DELETE) per merchant: plenty for a person, tight for a script. */
  dashboardWritesPerMerchant: { name: "dashboard-writes", perMinute: 30, burst: 30 },
} as const satisfies Record<string, Limit>;

const buckets = new Map<string, Bucket>();
let maxBuckets = 50_000;

/** Take one token or throw a 429 with Retry-After. */
export function consume(limit: Limit, key: string, nowMs = Date.now()): void {
  const id = `${limit.name}:${key}`;
  const ratePerMs = limit.perMinute / 60_000;
  let b = buckets.get(id);
  if (b) {
    buckets.delete(id); // re-inserted below: most recently used last
  } else {
    while (buckets.size >= maxBuckets) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    b = { tokens: limit.burst, updatedMs: nowMs };
  }
  buckets.set(id, b);
  b.tokens = Math.min(limit.burst, b.tokens + (nowMs - b.updatedMs) * ratePerMs);
  b.updatedMs = nowMs;
  if (b.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000));
    throw new HttpError(429, "rate_limited", "Too many requests. Try again in a moment.", { headers: { "Retry-After": String(retryAfter) } });
  }
  b.tokens -= 1;
}

export function resetRateLimitsForTests(options: { maxBuckets?: number } = {}): void {
  buckets.clear();
  maxBuckets = options.maxBuckets ?? 50_000;
}

export function bucketCountForTests(): number {
  return buckets.size;
}
