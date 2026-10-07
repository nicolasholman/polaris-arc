import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The keeper and this API sign to each other like merchant webhooks (and
 * Stripe's): `Polaris-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret,
 * "<t>.<body>")>`, with one shared secret (POLARIS_KEEPER_CALLBACK_SECRET).
 * services/keeper/src/callback.ts is the other half; the scheme must stay
 * byte-for-byte the same (test/credit.test.ts and the keeper's tests pin it).
 */

/** How far a callback's timestamp may be from our clock, in seconds. */
export const KEEPER_CALLBACK_TOLERANCE_SECONDS = 300;

export function signKeeperCallback(secret: string, body: string, timestamp: number): string {
  if (!secret) throw new Error("callback secret is empty");
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyKeeperSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  nowSeconds: number,
  toleranceSeconds = KEEPER_CALLBACK_TOLERANCE_SECONDS,
): { ok: true; timestamp: number } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing Polaris-Signature header" };
  const parts = new Map<string, string>();
  for (const p of header.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1")?.toLowerCase();
  if (!Number.isSafeInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed signature header" };
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = Buffer.from(signKeeperCallback(secret, body, t).split("v1=")[1] as string, "hex");
  const given = Buffer.from(v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true, timestamp: t } : { ok: false, reason: "signature mismatch" };
}
