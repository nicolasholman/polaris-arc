import "server-only";

import type { SplitRecord } from "@polaris/db";
import { encodeAbiParameters, getAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";

import { polarisSplitAbi } from "./chain/abis";
import { publicClient, requireChain } from "./chain/client";
import { getDb } from "./db";
import { explorerTxUrl, type ChainConfig } from "./env";
import { HttpError } from "./http";

/**
 * Split-the-bill links (PolarisSplit): the chain reads the relayer and the
 * public API share, and the records the chain sync keeps.
 *
 * The chain is the authority on a split: who organised it, each share's
 * amount, who paid which, whether it is closed (`splitOf`, `sharesOf`). The
 * `splits` records add what the chain only says in logs: when each share was
 * paid and in which transaction. Neither ever holds the split's words (what
 * it is for, the names): those travel in the link, and the chain keeps only
 * their hash (`memoHash`) for the app to check them against.
 */

/** PolarisSplit.MAX_SHARES. */
export const MAX_SHARES = 50;
/** PolarisSplit.MIN_LIFETIME and MAX_EXPIRY, in seconds. */
export const SPLIT_MIN_LIFETIME = 5 * 60;
export const SPLIT_MAX_EXPIRY = 60 * 86_400;

/** PolarisSplit.shareNonce: `keccak256(abi.encode(splitId, index))`, the ERC-3009 nonce a friend signs. */
export function shareNonce(splitId: Hex, index: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [splitId, index]));
}

/** PolarisSplit.splitIdOf: `keccak256(abi.encode(organiser, salt))`. */
export function splitIdOf(organiser: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [organiser, salt]));
}

/** The PolarisSplit address, or a 503 when this deployment predates it. */
export function requireSplitContract(chain: ChainConfig = requireChain()): Address {
  if (!chain.contracts.split) throw new HttpError(503, "split_unavailable", "Splitting a bill isn't available on this network yet.");
  return chain.contracts.split;
}

export type SplitOnChain = {
  splitId: Hex;
  organiser: Address;
  /** Unix seconds. */
  expiresAt: number;
  closed: boolean;
  total: bigint;
  paidTotal: bigint;
  memoHash: Hex;
  amounts: bigint[];
  /** Who paid each share; null while unpaid. */
  payers: Array<Address | null>;
};

/** A split as the chain has it now, or null when there is none with this id. */
export async function readSplit(splitId: Hex, chain: ChainConfig = requireChain()): Promise<SplitOnChain | null> {
  const address = requireSplitContract(chain);
  const client = publicClient();
  const [split, shares] = await Promise.all([
    client.readContract({ address, abi: polarisSplitAbi, functionName: "splitOf", args: [splitId] }),
    client.readContract({ address, abi: polarisSplitAbi, functionName: "sharesOf", args: [splitId] }),
  ]);
  if (getAddress(split.organiser) === zeroAddress) return null;
  const [amounts, payers] = shares;
  return {
    splitId: splitId.toLowerCase() as Hex,
    organiser: getAddress(split.organiser),
    expiresAt: Number(split.expiresAt),
    closed: split.closed,
    total: split.total,
    paidTotal: split.paidTotal,
    memoHash: split.memoHash,
    amounts: [...amounts],
    payers: payers.map((p) => (getAddress(p) === zeroAddress ? null : getAddress(p))),
  };
}

export type SplitStatus = "open" | "settled" | "closed" | "expired";

/** What `GET /api/public/splits/:id` and the organiser's book answer. Money in base units, as strings. */
export type SplitView = {
  id: Hex;
  organiser: Address;
  status: SplitStatus;
  totalUnits: string;
  paidUnits: string;
  shareCount: number;
  paidCount: number;
  /** ISO. */
  expiresAt: string;
  /** keccak256 of the link's words, which the app checks the link against. */
  memoHash: Hex;
  shares: Array<{
    index: number;
    amountUnits: string;
    paid: boolean;
    payer: Address | null;
    paidAt: string | null;
    txHash: Hex | null;
    explorerUrl: string | null;
  }>;
  createdAt: string | null;
  createdTxHash: Hex | null;
  closedAt: string | null;
};

export function statusOf(s: { closed: boolean; paidCount: number; shareCount: number; expiresAt: number }, nowSeconds = Math.floor(Date.now() / 1000)): SplitStatus {
  if (s.closed) return "closed";
  if (s.shareCount > 0 && s.paidCount === s.shareCount) return "settled";
  if (nowSeconds >= s.expiresAt) return "expired";
  return "open";
}

/** The view of a split from the chain's state, with the times and hashes the record adds. */
export function viewOf(onChain: SplitOnChain, record: SplitRecord | null): SplitView {
  const paidCount = onChain.payers.filter((p) => p !== null).length;
  return {
    id: onChain.splitId,
    organiser: onChain.organiser,
    status: statusOf({ closed: onChain.closed, paidCount, shareCount: onChain.amounts.length, expiresAt: onChain.expiresAt }),
    totalUnits: onChain.total.toString(),
    paidUnits: onChain.paidTotal.toString(),
    shareCount: onChain.amounts.length,
    paidCount,
    expiresAt: new Date(onChain.expiresAt * 1000).toISOString(),
    memoHash: onChain.memoHash,
    shares: onChain.amounts.map((amount, index) => {
      const paid = record?.shares[index] ?? null;
      const txHash = onChain.payers[index] ? (paid?.txHash ?? null) : null;
      return {
        index,
        amountUnits: amount.toString(),
        paid: onChain.payers[index] !== null,
        payer: onChain.payers[index] ?? null,
        paidAt: onChain.payers[index] ? (paid?.paidAt ?? null) : null,
        txHash,
        explorerUrl: txHash ? explorerTxUrl(txHash) : null,
      };
    }),
    createdAt: record?.createdAt ?? null,
    createdTxHash: record?.createdTxHash ?? null,
    closedAt: record?.closedAt ?? null,
  };
}

/** The view of a split from its record alone (the organiser's list: no chain read per split). */
export function viewOfRecord(record: SplitRecord): SplitView {
  const shareCount = record.amountsUnits.length;
  const paidUnits = record.shares.reduce((sum, s, i) => (s ? sum + BigInt(record.amountsUnits[i] ?? "0") : sum), 0n);
  return {
    id: record.id,
    organiser: getAddress(record.organiser),
    status: statusOf({ closed: record.closedAt !== null, paidCount: record.paidCount, shareCount, expiresAt: record.expiresAt }),
    totalUnits: record.totalUnits,
    paidUnits: paidUnits.toString(),
    shareCount,
    paidCount: record.paidCount,
    expiresAt: new Date(record.expiresAt * 1000).toISOString(),
    memoHash: record.memoHash,
    shares: record.amountsUnits.map((amountUnits, index) => {
      const paid = record.shares[index] ?? null;
      return {
        index,
        amountUnits,
        paid: paid !== null,
        payer: paid?.payer ?? null,
        paidAt: paid?.paidAt ?? null,
        txHash: paid?.txHash ?? null,
        explorerUrl: paid?.txHash ? explorerTxUrl(paid.txHash) : null,
      };
    }),
    createdAt: record.createdAt,
    createdTxHash: record.createdTxHash,
    closedAt: record.closedAt,
  };
}

/** `GET /api/public/splits/:id`: the chain's state now, with what the sync saw. Null when there is no such split. */
export async function splitView(splitId: Hex): Promise<SplitView | null> {
  const onChain = await readSplit(splitId);
  if (!onChain) return null;
  return viewOf(onChain, await getDb().splits.get(splitId.toLowerCase()));
}

/** The splits an account organised, newest first, from the records the chain sync keeps. */
export async function splitsOrganisedBy(organiser: Address, limit = 50): Promise<SplitView[]> {
  const records = await getDb().splits.find({ organiser: organiser.toLowerCase() }, { orderBy: "createdAt", direction: "desc", limit });
  return records.map(viewOfRecord);
}

/**
 * The record for a split, creating it from the chain when the sync meets a
 * payment or a close for a split it never saw opened (it started after the
 * split was created, or the logs arrived out of order).
 */
export async function ensureSplitRecord(splitId: Hex, at: string): Promise<SplitRecord | null> {
  const db = getDb();
  const id = splitId.toLowerCase() as Hex;
  const known = await db.splits.get(id);
  if (known) return known;
  const onChain = await readSplit(id);
  if (!onChain) return null;
  const record: SplitRecord = {
    id,
    organiser: onChain.organiser.toLowerCase(),
    totalUnits: onChain.total.toString(),
    amountsUnits: onChain.amounts.map(String),
    expiresAt: onChain.expiresAt,
    memoHash: onChain.memoHash,
    // Paid before we looked: who paid is known, the transaction isn't (the sync fills it in if it meets the log).
    shares: onChain.payers.map((payer) => (payer ? { payer, txHash: null, paidAt: at } : null)),
    paidCount: onChain.payers.filter((p) => p !== null).length,
    createdTxHash: null,
    createdBlock: null,
    createdAt: at,
    closedAt: onChain.closed ? at : null,
    closedTxHash: null,
    updatedAt: at,
  };
  try {
    return await db.splits.insert(record);
  } catch {
    return db.splits.get(id);
  }
}

/* ── The chain sync's side (ingest/ingest.ts) ───────────────────────────── */

/** PolarisSplit.SplitCreated: the split's record, once. */
export async function recordSplitCreated(
  e: { splitId: Hex; organiser: Address; total: bigint; amounts: readonly bigint[]; expiresAt: bigint; memoHash: Hex; txHash: Hex; blockNumber: number },
  at: string,
): Promise<void> {
  const db = getDb();
  const id = e.splitId.toLowerCase() as Hex;
  const created = { createdTxHash: e.txHash, createdBlock: e.blockNumber, createdAt: at };
  const updated = await db.splits.update(id, (r) => ({ ...r, ...created, updatedAt: at }));
  if (updated) return;
  try {
    await db.splits.insert({
      id,
      organiser: e.organiser.toLowerCase(),
      totalUnits: e.total.toString(),
      amountsUnits: e.amounts.map(String),
      expiresAt: Number(e.expiresAt),
      memoHash: e.memoHash,
      shares: e.amounts.map(() => null),
      paidCount: 0,
      ...created,
      closedAt: null,
      closedTxHash: null,
      updatedAt: at,
    });
  } catch {
    // Inserted meanwhile (the relay's receipt and the sync met the same log): keep that one's shares, add the creation.
    await db.splits.update(id, (r) => ({ ...r, ...created, updatedAt: at }));
  }
}

/** PolarisSplit.SharePaid: who paid the share, when, in which transaction. */
export async function recordSharePaid(e: { splitId: Hex; index: bigint; payer: Address; txHash: Hex }, at: string): Promise<void> {
  const known = await ensureSplitRecord(e.splitId, at);
  if (!known) return;
  const i = Number(e.index);
  await getDb().splits.update(known.id, (r) => {
    const shares = [...r.shares];
    while (shares.length <= i) shares.push(null);
    shares[i] = { payer: getAddress(e.payer), txHash: e.txHash, paidAt: shares[i]?.txHash ? shares[i].paidAt : at };
    return { ...r, shares, paidCount: shares.filter((s) => s !== null).length, updatedAt: at };
  });
}

/** PolarisSplit.SplitClosed: unpaid shares can no longer be paid. */
export async function recordSplitClosed(e: { splitId: Hex; txHash: Hex }, at: string): Promise<void> {
  const known = await ensureSplitRecord(e.splitId, at);
  if (!known) return;
  await getDb().splits.update(known.id, (r) => ({ ...r, closedAt: r.closedAt ?? at, closedTxHash: e.txHash, updatedAt: at }));
}
