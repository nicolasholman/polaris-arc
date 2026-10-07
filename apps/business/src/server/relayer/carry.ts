import "server-only";

import { isDuplicateKeyError, newId, type RelayKind, type RelayRecord } from "@polaris/db";
import type { Address, Hex, TransactionReceipt } from "viem";

import { requireChain } from "../chain/client";
import { getDb } from "../db";
import { explorerTxUrl, getConfig } from "../env";
import { HttpError } from "../http";
import { idsFromReceipt, ingestReceipt } from "../ingest/ingest";
import { getActivatorAccount, getRelayerAccount, type RelayerAccount } from "./signer";
import { RelayRejected, submitCall } from "./submit";

/**
 * Send one call as the relayer (or the registry admin) and keep the books:
 * a `relays` record per call, keyed by a digest of the signed request so the
 * same signatures are carried once, updated as the call is submitted and
 * confirmed; and, once the receipt is in, the chain events it produced are
 * ingested at once (records, session completion, webhooks).
 */

export type RelayResult = {
  relayId: string;
  txHash: Hex;
  status: "submitted" | "confirmed";
  blockNumber: number | null;
  explorerUrl: string | null;
  submittedAt: number;
  confirmedAt: number | null;
  /** paymentId, planId, subscriptionId, orderKey, … from the receipt. */
  ids: Record<string, string>;
};

export async function requireRelayer(): Promise<RelayerAccount> {
  const account = await getRelayerAccount();
  if (!account) {
    const config = getConfig();
    const reason = config.relayer.mode === "off" ? config.relayer.reason : "The relayer isn't configured.";
    throw new HttpError(503, "relayer_unavailable", `Payments can't be carried right now. Nothing was charged. (${reason})`);
  }
  return account;
}

export function fromRecord(record: RelayRecord): RelayResult {
  return {
    relayId: record.id,
    txHash: record.txHash as Hex,
    status: record.state === "confirmed" ? "confirmed" : "submitted",
    blockNumber: record.blockNumber,
    explorerUrl: record.txHash ? explorerTxUrl(record.txHash) : null,
    submittedAt: Date.parse(record.createdAt),
    confirmedAt: record.state === "confirmed" ? Date.parse(record.updatedAt) : null,
    ids: record.result ?? {},
  };
}

/**
 * Carry `data` to `to`. `relayId` makes it idempotent: a second call with the
 * same id returns the first call's transaction instead of sending again
 * (unless the first failed, in which case it is tried afresh).
 */
export async function carry(input: {
  kind: RelayKind;
  relayId?: string;
  role?: "relayer" | "activator";
  to: Address;
  data: Hex;
  signer: Address | null;
  sessionId?: string | null;
  merchantId?: string | null;
  waitMs?: number;
}): Promise<RelayResult> {
  const db = getDb();
  const role = input.role ?? "relayer";
  const account = role === "relayer" ? await requireRelayer() : await getActivatorAccount();
  if (!account) throw new HttpError(503, "activator_unavailable", "Merchant activation isn't configured on this server.");
  requireChain();

  const id = input.relayId ?? newId("rly", 20);
  const now = new Date().toISOString();
  const record: RelayRecord = {
    id,
    kind: input.kind,
    state: "pending",
    signer: input.signer,
    to: input.to,
    txHash: null,
    blockNumber: null,
    sessionId: input.sessionId ?? null,
    merchantId: input.merchantId ?? null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.relays.insert(record);
  } catch (error) {
    if (!(isDuplicateKeyError(error))) throw error;
    const existing = await db.relays.get(id);
    if (existing && existing.state !== "failed") {
      if (existing.state === "pending" || !existing.txHash) {
        throw new HttpError(409, "relay_in_progress", "This is already being processed. Give it a second.", { headers: { "Retry-After": "1" } });
      }
      return fromRecord(existing);
    }
    await db.relays.upsert(record); // the earlier attempt failed: try again with the same signatures
  }

  let submitted;
  try {
    submitted = await submitCall({ signer: account, role, to: input.to, data: input.data, waitMs: input.waitMs ?? getConfig().receiptTimeoutMs });
  } catch (error) {
    const e = error instanceof RelayRejected ? { code: error.error.code, message: error.error.message } : { code: "unavailable", message: (error as Error).message };
    await db.relays.update(id, (r) => ({ ...r, state: "failed", error: e, updatedAt: new Date().toISOString() }));
    throw error;
  }

  await db.relays.update(id, (r) => ({ ...r, state: "submitted", txHash: submitted.txHash, from: account.address, nonce: submitted.nonce, updatedAt: new Date().toISOString() }));
  const receipt = submitted.receipt;
  if (receipt) return finish(id, receipt);
  return fromRecord((await db.relays.get(id)) as RelayRecord);
}

async function finish(id: string, receipt: TransactionReceipt): Promise<RelayResult> {
  const db = getDb();
  const chain = requireChain();
  const ids = idsFromReceipt(receipt, chain);
  await db.relays.update(id, (r) => ({ ...r, result: ids }));
  try {
    await ingestReceipt(receipt);
  } catch (error) {
    // The chain sync will pick these logs up again; the buyer's payment is done either way.
    console.error("[relay] ingesting the receipt failed; the chain sync will retry", error);
  }
  const record = (await db.relays.get(id)) as RelayRecord;
  if (receipt.status !== "success") {
    await db.relays.update(id, (r) => ({ ...r, state: "failed", error: { code: "reverted", message: "The transaction reverted." } }));
    throw new HttpError(422, "transaction_reverted", "This didn't go through. Nothing was charged.");
  }
  return { ...fromRecord(record), status: "confirmed", blockNumber: Number(receipt.blockNumber), confirmedAt: Date.now(), ids };
}
