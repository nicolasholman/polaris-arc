import "server-only";

import type { Address, Log } from "viem";

import { logsClient, publicClient, requireChain } from "../chain/client";
import { getDb } from "../db";
import { resetNonceLane } from "../relayer/submit";
import { ingestLogs, ingestReceipt, watchedContracts } from "./ingest";

/**
 * The chain sync: read our contracts' logs block range by block range and
 * ingest them, so events nobody here sent (CRE collections, renewals and
 * liquidations; direct payments from a buyer's own wallet) still become
 * records and webhooks. The cursor only advances past a range once every
 * log in it was handled.
 *
 * With POLARIS_LOGS_RPC_URL set to Envio's HyperRPC for Monad, the logs come
 * from Envio's index (the dashboard, payouts, the buyer's book and every
 * webhook then run on Envio data), 10,000 blocks per request instead of the
 * public RPC's 100; receipts and reads still use POLARIS_RPC_URL.
 *
 * This is the fallback half of plan §5.1's "Envio HyperIndex → webhooks":
 * `ingestLogs` takes logs from anywhere, so the Envio indexer can feed the
 * same function when it is deployed.
 */

const CURSOR_ID = "logs";

export function chunkSize(chainId: number, hyperRpc = false): number {
  const configured = Number(process.env.POLARIS_SYNC_CHUNK_BLOCKS ?? "");
  if (Number.isInteger(configured) && configured > 0) return configured;
  // Monad's public RPC caps eth_getLogs at 100 blocks (40 s of chain); Envio's HyperRPC serves wide ranges from its index.
  if (hyperRpc) return 10_000;
  return chainId === 31337 ? 2_000 : 100;
}

/**
 * POLARIS_SYNC_FROM_BLOCK as a block number, or null when it is unset or
 * blank. (`Number("")` is 0: read naively, an unset variable meant "from
 * genesis", which on a fork of Monad testnet is tens of millions of blocks
 * of 100-block reads.)
 */
export function configuredFromBlock(raw: string | undefined = process.env.POLARIS_SYNC_FROM_BLOCK): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export type SyncSummary = { from: number; to: number; logs: number; events: number; caughtUp: boolean };

export async function syncChain(options: { maxRanges?: number } = {}): Promise<SyncSummary> {
  const chain = requireChain();
  const client = publicClient();
  const logs = logsClient();
  const db = getDb();
  const latest = Number(await client.getBlockNumber());

  let cursor = await db.cursors.get(CURSOR_ID);
  if (!cursor) {
    // First run: start from the configured block, else the deployment's first block, else now (no backfill).
    const start = configuredFromBlock() ?? chain.fromBlock ?? latest;
    cursor = await db.cursors.upsert({ id: CURSOR_ID, block: start - 1, updatedAt: new Date().toISOString() });
  }

  const addresses = Object.values(watchedContracts(chain)).filter((a): a is Address => a !== null);
  const size = chunkSize(chain.id, chain.logsRpcUrl !== null);
  const first = cursor.block + 1;
  let from = first;
  let seen = 0;
  let events = 0;
  for (let i = 0; i < (options.maxRanges ?? 20) && from <= latest; i++) {
    const to = Math.min(latest, from + size - 1);
    const found = (await logs.getLogs({ address: addresses, fromBlock: BigInt(from), toBlock: BigInt(to) })) as Log[];
    const summary = await ingestLogs(found);
    seen += found.length;
    events += summary.events;
    await db.cursors.upsert({ id: CURSOR_ID, block: to, updatedAt: new Date().toISOString() });
    from = to + 1;
  }
  return { from: first, to: from - 1, logs: seen, events, caughtUp: from > latest };
}

/** How long a submitted relay may go without a receipt before we ask whether it was dropped. */
export function dropAfterMs(): number {
  const raw = process.env.RELAYER_DROP_AFTER_MS?.trim();
  const configured = Number(raw);
  return raw && Number.isFinite(configured) && configured >= 0 ? configured : 10 * 60_000;
}

export type ReconcileSummary = { settled: number; dropped: number; waiting: number };

/**
 * Finish relays whose receipt we didn't wait long enough for: fetch each
 * receipt and ingest it (which confirms the relay, pays out the payout, and
 * sends the webhooks).
 *
 * A transaction can also never land: the node dropped it, or another
 * transaction took its nonce. After `dropAfterMs` without a receipt, a relay
 * whose transaction the node no longer knows, or whose nonce the relayer has
 * already used on chain, is marked failed (`dropped`), which frees its
 * checkout for a retry and its nonce lane. One the node still holds is left
 * to land.
 *
 * Relays are visited least recently checked first, so a few that never
 * resolve can't keep newer ones (and payouts) from being reconciled.
 */
export async function reconcileRelays(options: { olderThanMs?: number; limit?: number } = {}): Promise<ReconcileSummary> {
  const db = getDb();
  const client = publicClient();
  const now = Date.now();
  const cutoff = new Date(now - (options.olderThanMs ?? 5_000)).toISOString();
  const due = await db.relays.find({ state: "submitted", checkedAt: { lte: cutoff } }, { orderBy: "checkedAt", limit: options.limit ?? 20 });
  const summary: ReconcileSummary = { settled: 0, dropped: 0, waiting: 0 };
  for (const relay of due) {
    if (!relay.txHash) continue;
    const hash = relay.txHash;
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) {
      await ingestReceipt(receipt);
      summary.settled++;
      continue;
    }
    let dropped: string | null = null;
    if (now - Date.parse(relay.createdAt) > dropAfterMs()) {
      const tx = await client.getTransaction({ hash }).catch(() => null);
      if (!tx) {
        dropped = "The network dropped this transaction. Nothing was charged.";
      } else if (relay.from && typeof relay.nonce === "number") {
        const used = await client.getTransactionCount({ address: relay.from, blockTag: "latest" }).catch(() => null);
        if (used !== null && used > relay.nonce) dropped = "Another transaction took this one's place. Nothing was charged.";
      }
    }
    const at = new Date().toISOString();
    if (dropped) {
      const error = { code: "dropped", message: dropped };
      await db.relays.update(relay.id, (r) => ({ ...r, state: "failed", error, checkedAt: at, updatedAt: at }));
      if (relay.from) resetNonceLane(relay.from);
      console.warn(`[relay] ${relay.id} (${hash}) never landed: marked failed`);
      summary.dropped++;
    } else {
      await db.relays.update(relay.id, (r) => ({ ...r, checkedAt: at }));
      summary.waiting++;
    }
  }
  return summary;
}
