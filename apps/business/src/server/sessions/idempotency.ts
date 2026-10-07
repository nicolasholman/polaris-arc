import "server-only";

import { canonicalJson, isDuplicateKeyError, sha256Hex } from "@polaris/db";

import { getDb } from "../db";
import { HttpError } from "../http";

/**
 * Idempotency keys, Stripe's way.
 *
 * The first request with a key claims it (an `insert`, which only one request
 * can win), runs, and stores its response. A retry with the same key and the
 * same parameters gets that stored response back (200 instead of 201); with
 * different parameters it gets 409 `idempotency_key_reused`; while the first
 * is still running, 409 `idempotency_in_progress`, which the SDK retries.
 * A request that fails doesn't keep the key, so it can be retried as is.
 * Keys live for 24 hours.
 */

const TTL_MS = 24 * 3_600_000;
/** A claim this old belonged to a request that died; let a retry take it over. */
const ABANDONED_MS = 60_000;
const KEY = /^[\x21-\x7e]{1,255}$/;

export type Replayable = { status: number; body: unknown };

export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export async function withIdempotency(
  scope: string,
  key: string | null,
  requestHash: string,
  run: () => Promise<Replayable>,
): Promise<Replayable & { replayed: boolean }> {
  if (key === null) return { ...(await run()), replayed: false };
  if (!KEY.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1 to 255 printable characters.", { param: "Idempotency-Key" });
  }
  const db = getDb();
  const id = `${scope}:${key}`;
  const now = Date.now();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db.idempotency.insert({ id, requestHash, state: "in_progress", status: null, body: null, createdAt: new Date(now).toISOString(), expiresAtMs: now + TTL_MS });
      break;
    } catch (error) {
      if (!(isDuplicateKeyError(error))) throw error;
      const existing = await db.idempotency.get(id);
      if (!existing) continue;
      const stale = existing.expiresAtMs <= now || (existing.state === "in_progress" && now - Date.parse(existing.createdAt) > ABANDONED_MS);
      if (stale && attempt === 0) {
        await db.idempotency.delete(id);
        continue;
      }
      if (existing.requestHash !== requestHash) {
        throw new HttpError(409, "idempotency_key_reused", "This Idempotency-Key was already used with different parameters. Use a new key for a new request.", {
          param: "Idempotency-Key",
        });
      }
      if (existing.state === "in_progress") {
        throw new HttpError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed. Retry in a moment.", {
          headers: { "Retry-After": "1" },
        });
      }
      return { status: 200, body: existing.body === null ? null : JSON.parse(existing.body), replayed: true };
    }
  }

  let result: Replayable;
  try {
    result = await run();
  } catch (error) {
    await db.idempotency.delete(id);
    throw error;
  }
  if (result.status >= 200 && result.status < 300) {
    const created = (result.body as { id?: unknown } | null)?.id;
    await db.idempotency.update(id, (r) => ({ ...r, state: "done", status: result.status, body: JSON.stringify(result.body), resourceId: typeof created === "string" ? created : null }));
  } else {
    await db.idempotency.delete(id);
  }
  return { ...result, replayed: false };
}
