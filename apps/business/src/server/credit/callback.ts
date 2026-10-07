import "server-only";

import { isDuplicateKeyError } from "@polaris/db";
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { afterResponse } from "../background";
import { getDb } from "../db";
import { HttpError } from "../http";
import { syncChain } from "../ingest/sync";
import { recordDecision, recordUnavailable } from "./underwriting";

/**
 * `POST /api/cre/callback`: what the CRE workflows report after a run, signed
 * with POLARIS_CRE_CALLBACK_SECRET (auth.ts `withCreCallback` verifies it).
 *
 * - `credit.underwritten` / `credit.refused` / `credit.thin` (underwriting):
 *   the decision for the account is recorded, its request closed, and the
 *   app's credit screen shows it (`GET /api/public/credit/{account}`).
 * - `credit.unavailable` (underwriting): the review needs a data provider the
 *   workflow has no key for (`notConfigured`: Nansen, Zerion or Etherscan).
 *   No decision is recorded, since nothing was decided; the account's open
 *   request fails with a sentence naming the provider and its key, which
 *   "Raise your limit" shows instead of waiting.
 * - `collections.run`: a collections report landed; the chain sync runs now
 *   rather than on its next tick, so instalment webhooks and dunning follow
 *   at once. The chain events stay the source of truth: the callback only
 *   says where to look.
 * - `collections.heartbeat`: a collections run happened, idle or not (the
 *   local runner, workflows/scripts/local-collections.mjs, sends one per
 *   run). An idle run writes nothing on chain, so this is how the
 *   dashboard's Collections card knows the runner is alive.
 *
 * Every node of the DON may deliver the same callback, so each `id` is
 * handled once; an unknown type is acknowledged (so the DON doesn't retry)
 * and ignored.
 */

type Payload = {
  id?: unknown;
  type?: unknown;
  user?: unknown;
  linkedWallet?: unknown;
  score?: unknown;
  reason?: unknown;
  txHash?: unknown;
  notConfigured?: unknown;
};

const DECISIONS = { "credit.underwritten": "applied", "credit.refused": "refused", "credit.thin": "thin" } as const;

export async function handleCreCallback(raw: string): Promise<{ id: string; type: string; duplicate: boolean }> {
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    throw new HttpError(400, "invalid_json", "The callback body isn't valid JSON.");
  }
  if (!payload || typeof payload !== "object" || typeof payload.id !== "string" || !payload.id || typeof payload.type !== "string") {
    throw new HttpError(400, "invalid_body", "A callback needs a string id and type.");
  }
  const { id, type } = payload as { id: string; type: string };
  const decision = DECISIONS[type as keyof typeof DECISIONS];
  const unavailable = type === "credit.unavailable";
  let user: Address | null = null;
  if (decision || unavailable) {
    if (typeof payload.user !== "string" || !isAddress(payload.user, { strict: false })) {
      throw new HttpError(400, "invalid_body", `${type} needs the user's address.`, { param: "user" });
    }
    user = getAddress(payload.user);
  }

  const db = getDb();
  try {
    await db.creCallbacks.insert({ id: id.slice(0, 200), type, receivedAt: new Date().toISOString() });
  } catch (error) {
    if (isDuplicateKeyError(error)) return { id, type, duplicate: true };
    throw error;
  }
  try {
    if (decision && user) {
      const linked = typeof payload.linkedWallet === "string" && isAddress(payload.linkedWallet, { strict: false }) ? getAddress(payload.linkedWallet) : null;
      await recordDecision({
        callbackId: id,
        status: decision,
        user,
        score: typeof payload.score === "number" && Number.isFinite(payload.score) ? payload.score : null,
        reason: typeof payload.reason === "string" ? payload.reason.slice(0, 500) : null,
        linkedWallet: linked,
        txHash: typeof payload.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(payload.txHash) ? (payload.txHash as Hex) : null,
      });
    } else if (unavailable && user) {
      const named = Array.isArray(payload.notConfigured) ? payload.notConfigured : [];
      await recordUnavailable({
        user,
        providers: named.map((n) => (n && typeof n === "object" ? (n as { provider?: unknown }).provider : n)).filter((p): p is string => typeof p === "string"),
      });
    } else if (type === "collections.run") {
      afterResponse("cre: chain sync", () => syncChain());
    } else if (type === "collections.heartbeat") {
      const at = new Date().toISOString();
      const current = await db.collectorRuns.get("cre");
      await db.collectorRuns.upsert({
        id: "cre",
        lastRunAt: at,
        lastRunBlock: current?.lastRunBlock ?? null,
        lastTxHash: current?.lastTxHash ?? null,
        tasks: current?.tasks ?? 0,
        executed: current?.executed ?? 0,
        skipped: current?.skipped ?? 0,
      });
    }
  } catch (error) {
    // Let the DON's retry (or the next node's delivery) try again.
    await db.creCallbacks.delete(id.slice(0, 200));
    throw error;
  }
  return { id, type, duplicate: false };
}
