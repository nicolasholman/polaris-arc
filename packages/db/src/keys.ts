import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * API keys, webhook secrets and ids.
 *
 * Every random value comes from the OS CSPRNG (the old merchant platform used
 * `Math.random` for webhook secrets). Secret keys are stored only as a keyed
 * hash: HMAC-SHA256 under a server-side pepper, so a leaked table can't be
 * used to test guesses without the pepper too. A 40-character base62 secret
 * carries ~238 bits, so no slow KDF is needed.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A uniformly random base62 string. */
export function randomBase62(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[randomInt(0, BASE62.length)];
  return out;
}

/** `prefix_` + random base62, e.g. `evt_3kQ…`. */
export function newId(prefix: string, length = 20): string {
  return `${prefix}_${randomBase62(length)}`;
}

/** A 32-byte 0x-hex value, e.g. an ERC-3009 nonce. */
export function randomBytes32(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

export type KeyMode = "test" | "live";
export type KeyKind = "secret" | "publishable";

export const KEY_PREFIX = {
  secret: { test: "sk_test_", live: "sk_live_" },
  publishable: { test: "pk_test_", live: "pk_live_" },
} as const;

export const WEBHOOK_SECRET_PREFIX = "whsec_";
const SECRET_LENGTH = 40;
const PUBLISHABLE_LENGTH = 24;

export function newSecretKey(mode: KeyMode = "test"): string {
  return KEY_PREFIX.secret[mode] + randomBase62(SECRET_LENGTH);
}

export function newPublishableKey(mode: KeyMode = "test"): string {
  return KEY_PREFIX.publishable[mode] + randomBase62(PUBLISHABLE_LENGTH);
}

export function newWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBase62(32);
}

const KEY_PATTERN = /^(sk|pk)_(test|live)_([0-9A-Za-z]{16,128})$/;

/** What a presented key claims to be, or null if it isn't shaped like one of ours. */
export function parseApiKey(value: string): { kind: KeyKind; mode: KeyMode } | null {
  const m = KEY_PATTERN.exec(value);
  if (!m) return null;
  return { kind: m[1] === "sk" ? "secret" : "publishable", mode: m[2] as KeyMode };
}

/**
 * The stored form of a secret key. With a pepper: `hmac256:<hex>`. Without
 * one (local development only; the server refuses to start in production
 * without it): `sha256:<hex>`.
 */
export function hashSecretKey(secret: string, pepper: string | undefined): string {
  return pepper
    ? `hmac256:${createHmac("sha256", pepper).update(secret).digest("hex")}`
    : `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

/** Constant-time comparison of two stored hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `sk_test_…a1b2`: enough to recognise a key, never enough to use it. */
export function keyHint(secret: string): string {
  const prefix = /^[a-z]+_(?:test_|live_)?/.exec(secret)?.[0] ?? "";
  return `${prefix}…${secret.slice(-4)}`;
}

/** SHA-256 hex of a string: request fingerprints for idempotency. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * JSON with object keys sorted, so two requests that differ only in key order
 * fingerprint the same.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
