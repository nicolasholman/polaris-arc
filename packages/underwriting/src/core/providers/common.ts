/**
 * Pieces every provider module shares: the request shape, timestamp parsing,
 * query strings and base64, all without Node or DOM APIs.
 */

export interface RequestSpec {
  provider: "nansen" | "zerion" | "etherscan" | "rpc";
  /** Short endpoint name, used in evidence sources: `nansen.first-funder`. */
  endpoint: string;
  method: "GET" | "POST";
  /** Full URL, with no secret in it. Etherscan's key is appended by the caller. */
  url: string;
  /** Non-secret headers. The caller adds auth. */
  headers: Record<string, string>;
  /** The exact JSON text to send. Byte-identical on every node, so CRE's cache can share it. */
  body?: string;
}

/** A response the shape did not match. The evidence becomes missing, never empty. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ParseError(`${what} is not an array`);
  return v;
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|z|UTC|[+-]\d{2}:?\d{2})?$/;

/**
 * Unix seconds from whatever a provider sends: ISO 8601 with or without an
 * offset (no offset means UTC, never the machine's zone), "YYYY-MM-DD HH:MM:SS",
 * unix seconds or milliseconds as a number or a numeric string. Null when it
 * cannot be read. Nansen's `first-funder.block_timestamp` format is
 * UNVERIFIED (data.md §2.5.1), so this is deliberately permissive.
 */
export function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.floor(v > 1e12 ? v / 1000 : v);
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return parseTimestamp(Number(s));
  const m = ISO.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0", , tz] = m;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  if (!Number.isFinite(t)) return null;
  if (tz && tz !== "Z" && tz !== "z" && tz !== "UTC") {
    const sign = tz.startsWith("-") ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    t -= sign * offsetMin * 60_000;
  }
  return Math.floor(t / 1000);
}

/** Unix seconds to ISO 8601, rounded down to the minute, so every node builds the same body. */
export function isoMinute(unixSeconds: number): string {
  const t = Math.floor(unixSeconds / 60) * 60;
  return new Date(t * 1000).toISOString().replace(".000Z", "Z");
}

/** `a=1&b=2`, percent-encoding keys too, so `filter[chain_ids]` becomes `filter%5Bchain_ids%5D` as Zerion's own links do. */
export function queryString(params: ReadonlyArray<readonly [string, string | number | undefined]>): string {
  return params
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of an ASCII string (API keys), without btoa or Buffer. */
export function base64Ascii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    if (a > 127 || b > 127 || c > 127) throw new RangeError("base64Ascii takes ASCII only");
    const n = (a << 16) | ((Number.isNaN(b) ? 0 : b) << 8) | (Number.isNaN(c) ? 0 : c);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += Number.isNaN(b) ? "=" : B64[(n >> 6) & 63]!;
    out += Number.isNaN(c) ? "=" : B64[n & 63]!;
  }
  return out;
}

export function lower(address: string): string {
  return address.toLowerCase();
}

export function isAddress(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** A float amount to 6-decimal base units, rounded to the nearest unit. */
export function floatToMicros(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const m = Math.round(x * 1e6);
  return Number.isSafeInteger(m) ? m : Number.MAX_SAFE_INTEGER;
}

/**
 * Binary search for the largest edge where `hit(edge)` holds, given that a
 * hit at N implies a hit at every smaller edge. Returns null when none hits.
 * Synchronous, for CRE's `.result()` style; see `largestHitAsync`.
 */
export function largestHit(edges: readonly number[], hit: (edge: number) => boolean): number | null {
  let lo = 0;
  let hi = edges.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hit(edges[mid]!)) {
      best = edges[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export async function largestHitAsync(
  edges: readonly number[],
  hit: (edge: number) => Promise<boolean>,
): Promise<number | null> {
  let lo = 0;
  let hi = edges.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (await hit(edges[mid]!)) {
      best = edges[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
