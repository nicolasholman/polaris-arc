import "server-only";

import type { WalletMoveRecord } from "@polaris/db";
import { decodeEventLog, getAddress, parseAbi, toEventSelector, zeroAddress, type Address, type Hex, type Log } from "viem";

import { polarisSendAbi, polarisSplitAbi } from "./chain/abis";
import { logsClient, publicClient, requireChain } from "./chain/client";
import { getDb } from "./db";
import type { ChainConfig } from "./env";
import { chunkSize, configuredFromBlock } from "./ingest/sync";

/**
 * Every dollar that moved in or out of one address, from the chain: what the
 * Polaris app needs beside the merchant records (buyers.ts) so a buyer's
 * activity and balance history add up. Money added (a mint, or dollars sent
 * in), transfers to and from people, send links made, claimed or taken back,
 * shares of a split paid (and, for its organiser, each share arriving: the
 * split and share from PolarisSplit's SharePaid in the same transaction), and
 * the transfers inside a payment or an instalment (kept for the balance,
 * shown through the payment's own row).
 *
 * Read per address, on demand, from the AUSD `Transfer` logs to or from it
 * and PolarisSend's `Sent`/`Claimed`/`Cancelled`/`Refunded` logs that name
 * it, block range by block range from the deployment (or where it left off:
 * a cursor per address), and kept in `wallet_moves`. The same logs client as
 * the chain sync: Envio's HyperRPC when POLARIS_LOGS_RPC_URL is set.
 */

const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const TRANSFER = toEventSelector(erc20[0]);
const sendEvent = (name: "Sent" | "Claimed" | "Cancelled" | "Refunded") =>
  toEventSelector(polarisSendAbi.find((e) => e.type === "event" && e.name === name) as Parameters<typeof toEventSelector>[0]);
const SENT = sendEvent("Sent");
const CLAIMED = sendEvent("Claimed");
const CANCELLED = sendEvent("Cancelled");
const REFUNDED = sendEvent("Refunded");
const SHARE_PAID = toEventSelector(polarisSplitAbi.find((e) => e.type === "event" && e.name === "SharePaid") as Parameters<typeof toEventSelector>[0]);

/** Ranges read per request: the rest waits for the next read (the app asks every 15 s). */
const MAX_RANGES = 25;
const LIMIT = 200;

const topic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const cursorId = (who: string) => `moves:${who}`;

const blockTimes = new Map<number, string>();
async function blockTime(n: number): Promise<string> {
  const cached = blockTimes.get(n);
  if (cached) return cached;
  let iso: string;
  try {
    iso = new Date(Number((await publicClient().getBlock({ blockNumber: BigInt(n) })).timestamp) * 1000).toISOString();
  } catch {
    iso = new Date().toISOString();
  }
  if (blockTimes.size > 5_000) blockTimes.clear();
  blockTimes.set(n, iso);
  return iso;
}

/** A transaction's logs, from its receipt (cached). */
const txLogs = new Map<Hex, Log[]>();
async function logsOf(txHash: Hex): Promise<Log[]> {
  const cached = txLogs.get(txHash);
  if (cached) return cached;
  const receipt = await publicClient().getTransactionReceipt({ hash: txHash });
  if (txLogs.size > 5_000) txLogs.clear();
  txLogs.set(txHash, receipt.logs as Log[]);
  return receipt.logs as Log[];
}

/** Which Polaris contract (if any) emitted logs in a transaction: how a transfer inside it is told apart. */
async function contractsIn(txHash: Hex): Promise<Set<string>> {
  return new Set((await logsOf(txHash)).map((l) => l.address.toLowerCase()));
}

/** The split share a transaction paid (PolarisSplit.SharePaid), for the friend's and the organiser's rows. */
async function shareIn(chain: ChainConfig, txHash: Hex): Promise<{ splitId: Hex; shareIndex: number } | null> {
  const split = chain.contracts.split?.toLowerCase();
  if (!split) return null;
  for (const log of await logsOf(txHash).catch(() => [] as Log[])) {
    if (log.address.toLowerCase() !== split || log.topics[0] !== SHARE_PAID) continue;
    try {
      const out = decodeEventLog({ abi: polarisSplitAbi, eventName: "SharePaid", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return { splitId: out.args.splitId.toLowerCase() as Hex, shareIndex: Number(out.args.index) };
    } catch {
      /* not a SharePaid after all */
    }
  }
  return null;
}

type Parsed = { log: Log; txHash: Hex; logIndex: number; blockNumber: number };
const parsed = (log: Log): Parsed | null =>
  log.transactionHash && log.logIndex !== null && log.blockNumber !== null
    ? { log, txHash: log.transactionHash, logIndex: Number(log.logIndex), blockNumber: Number(log.blockNumber) }
    : null;

function classify(
  chain: ChainConfig,
  direction: "in" | "out",
  counterparty: Address,
  inTx: Set<string>,
  sendLogs: Array<{ event: string; linkKey: Address }>,
): { kind: WalletMoveRecord["kind"]; linkKey: Address | null } {
  const c = chain.contracts;
  const other = counterparty.toLowerCase();
  if (direction === "in" && other === zeroAddress) return { kind: "added", linkKey: null };
  if (other === c.send.toLowerCase()) {
    const find = (...events: string[]) => sendLogs.find((s) => events.includes(s.event))?.linkKey ?? null;
    if (direction === "out") return { kind: "sent-link", linkKey: find("Sent") };
    const claimed = find("Claimed");
    if (claimed) return { kind: "claimed", linkKey: claimed };
    return { kind: "link-returned", linkKey: find("Cancelled", "Refunded") };
  }
  // A share of a split: the friend's dollars go through PolarisSplit to the organiser in one transaction.
  if (c.split && other === c.split.toLowerCase()) return { kind: direction === "out" ? "split-paid" : "split-received", linkKey: null };
  const has = (a: Address | null) => a !== null && inTx.has(a.toLowerCase());
  if (has(c.payments) || has(c.checkout)) return { kind: direction === "out" ? "payment" : "refund", linkKey: null };
  if (has(c.loanEngine) || has(c.collections)) return { kind: direction === "out" ? "instalment" : "received", linkKey: null };
  return { kind: direction === "out" ? "sent" : "received", linkKey: null };
}

async function readRange(chain: ChainConfig, who: Address, from: number, to: number, openLinks: Address[]): Promise<void> {
  const db = getDb();
  const logs = logsClient();
  const me = topic(who);
  const get = (address: Address, topics: Array<Hex | Hex[] | null>) =>
    logs.request({ method: "eth_getLogs", params: [{ address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }) as Promise<Log[]>;
  const [outs, ins, mySends, myClaims] = await Promise.all([
    get(chain.contracts.stablecoin, [TRANSFER, me]),
    get(chain.contracts.stablecoin, [TRANSFER, null, me]),
    get(chain.contracts.send, [[SENT, CANCELLED, REFUNDED], null, me]),
    get(chain.contracts.send, [CLAIMED, null, me]),
  ]);

  // Send-contract events in each transaction that name this address, for the transfers beside them.
  const sendsByTx = new Map<string, Array<{ event: string; linkKey: Address }>>();
  const newLinks: Address[] = [];
  for (const log of [...mySends, ...myClaims]) {
    try {
      const out = decodeEventLog({ abi: polarisSendAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const linkKey = getAddress((out.args as { linkKey: Address }).linkKey);
      const key = (log.transactionHash ?? "").toLowerCase();
      sendsByTx.set(key, [...(sendsByTx.get(key) ?? []), { event: String(out.eventName), linkKey }]);
      if (out.eventName === "Sent") newLinks.push(linkKey);
    } catch {
      /* not one of ours */
    }
  }

  for (const log of [...outs, ...ins]) {
    const p = parsed(log);
    if (!p) continue;
    const t = decodeEventLog({ abi: erc20, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args;
    const from = getAddress(t.from);
    const toAddr = getAddress(t.to);
    if (from === toAddr) continue;
    const direction = from === who ? "out" : "in";
    const counterparty = direction === "out" ? toAddr : from;
    const inTx = counterparty === zeroAddress ? new Set<string>() : await contractsIn(p.txHash).catch(() => new Set<string>());
    const { kind, linkKey } = classify(chain, direction, counterparty, inTx, sendsByTx.get(p.txHash.toLowerCase()) ?? []);
    const id = `${p.txHash}:${p.logIndex}:${who.toLowerCase()}`;
    // Kept once: a range read again never forgets that a link was claimed since.
    if (await db.walletMoves.get(id)) continue;
    const share = kind === "split-paid" || kind === "split-received" ? await shareIn(chain, p.txHash) : null;
    await db.walletMoves.insert({
      id,
      address: who.toLowerCase(),
      kind,
      direction,
      amountUnits: t.value.toString(),
      counterparty,
      txHash: p.txHash,
      logIndex: p.logIndex,
      blockNumber: p.blockNumber,
      linkKey,
      settledAt: null,
      settledAs: null,
      splitId: share?.splitId ?? null,
      shareIndex: share?.shareIndex ?? null,
      at: await blockTime(p.blockNumber),
    });
  }

  // This address's links that were claimed or taken back in the range: the sender sees "Claimed".
  const watch = [...new Set([...openLinks, ...newLinks].map((k) => k.toLowerCase()))].slice(0, 100);
  if (watch.length === 0) return;
  const settled = await get(chain.contracts.send, [[CLAIMED, CANCELLED, REFUNDED], watch.map((k) => topic(k as Address))]);
  for (const log of settled) {
    const p = parsed(log);
    if (!p) continue;
    const out = decodeEventLog({ abi: polarisSendAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    const linkKey = (out.args as { linkKey: Address }).linkKey.toLowerCase();
    const at = await blockTime(p.blockNumber);
    const rows = await db.walletMoves.find({ address: who.toLowerCase(), linkKey }, { limit: 5 });
    for (const row of rows) {
      if (row.kind !== "sent-link" || row.settledAt) continue;
      await db.walletMoves.update(row.id, (r) => ({ ...r, settledAt: at, settledAs: out.eventName === "Claimed" ? "claimed" : "returned" }));
    }
  }
}

const inflight = new Map<string, Promise<void>>();

/** Read this address's moves up to the latest block (one read at a time per address). */
export function syncWalletMoves(address: Address): Promise<void> {
  const who = address.toLowerCase();
  const running = inflight.get(who);
  if (running) return running;
  const run = (async () => {
    const chain = requireChain();
    const db = getDb();
    const latest = Number(await publicClient().getBlockNumber());
    const start = configuredFromBlock() ?? chain.fromBlock ?? (chain.local ? 0 : Math.max(0, latest - 10_000));
    const cursor = await db.cursors.get(cursorId(who));
    const size = chunkSize(chain.id, chain.logsRpcUrl !== null);
    let from = cursor ? cursor.block + 1 : start;
    const open = (await db.walletMoves.find({ address: who }, { orderBy: "at", direction: "desc", limit: LIMIT }))
      .filter((m) => m.kind === "sent-link" && !m.settledAt && m.linkKey)
      .map((m) => m.linkKey as Address);
    for (let i = 0; i < MAX_RANGES && from <= latest; i++) {
      const to = Math.min(latest, from + size - 1);
      await readRange(chain, getAddress(address), from, to, open);
      await db.cursors.upsert({ id: cursorId(who), block: to, updatedAt: new Date().toISOString() });
      from = to + 1;
    }
  })().finally(() => inflight.delete(who));
  inflight.set(who, run);
  return run;
}

/** This address's moves, newest first. Reads the chain up to now first; a failed read serves what is kept. */
export async function walletMoves(address: Address): Promise<WalletMoveRecord[]> {
  try {
    await syncWalletMoves(address);
  } catch (error) {
    console.warn(`[moves] ${address}: ${(error as Error).message}`);
  }
  return getDb().walletMoves.find({ address: address.toLowerCase() }, { orderBy: "at", direction: "desc", limit: LIMIT });
}
