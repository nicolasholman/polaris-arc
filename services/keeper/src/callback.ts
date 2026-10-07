/**
 * Signed callbacks to Polaris for Business (`POST /api/keeper/callback`), and
 * the check on the business's signed underwriting requests to this keeper.
 * Both ways use the merchant-webhook scheme: `Polaris-Signature: t=<unix>,
 * v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, with one shared secret
 * (POLARIS_KEEPER_CALLBACK_SECRET). apps/business/src/server/credit/
 * callback-signature.ts is the other half; test/callback.test.ts pins it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 300;

export function sign(secret: string, body: string, timestamp: number): string {
  if (!secret) throw new Error("callback secret is empty");
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verify(secret: string, body: string, header: string | null | undefined, nowSeconds: number): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing Polaris-Signature header" };
  const parts = new Map<string, string>();
  for (const p of header.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1")?.toLowerCase();
  if (!Number.isSafeInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed signature header" };
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = Buffer.from(sign(secret, body, t).split("v1=")[1]!, "hex");
  const given = Buffer.from(v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

export type Callback = { id: string; type: string; [k: string]: unknown };

/** POST one callback; returns the status, or null when callbacks aren't configured or the API is unreachable. */
export async function postCallback(target: { url: string; secret: string } | null, payload: Callback): Promise<number | null> {
  if (!target) return null;
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", "polaris-signature": sign(target.secret, body, Math.floor(Date.now() / 1000)) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch (e) {
    console.error(`[keeper] callback ${payload.type} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
