import "server-only";

import type { CheckoutSessionRecord, IndexerOutboxRecord, MerchantRecord } from "@polaris/db";
import {
  createIndexerClient,
  IncompleteActivityError,
  IndexerError,
  nextCursor,
  toWebhookEvent,
  validateWebhookEvent,
  webhookSourceKey,
  type Activity,
  type IndexerClient,
  type WebhookSession,
} from "@polarispay/indexer-client";

import { getDb } from "../db";
import { getConfig, type ChainConfig } from "../env";
import { settlementMismatch } from "../ingest/ingest";
import { configuredFromBlock } from "../ingest/sync";
import { merchantByWallet } from "../merchants";
import { periodSeconds } from "../sessions/params";
import { emitEvent, eventIdFor } from "./events";

/**
 * Webhooks from the Envio indexer: with POLARIS_INDEXER_URL set, read the
 * indexer's `Activity` outbox (one row per polarispay-sdk event, in chain
 * order) after a cursor, five rows at a time, and emit each row's event
 * through the same `emitEvent` the chain sync uses. Signing, delivery and
 * retries are the dispatcher's, unchanged.
 *
 * Both paths keep running: the chain sync also writes this server's records
 * (sessions, plans, payments, receipts), and its receipt path answers in the
 * same second for a relayed transaction. They emit the same chain event
 * under the same id (`evt_` + sha256 of `<txHash>:<logIndex>:<type>`), so
 * whichever sees it first stores it and queues its deliveries, and the other
 * finds the id taken and sends nothing. Each event records its source.
 *
 * What the chain doesn't know comes from this server's records, as the chain
 * sync does it: the merchant's public id, the checkout session behind an
 * order (and whether the settlement paid it: one that didn't sends no
 * `payment.succeeded` or `plan.opened`), a plan's or subscription's order
 * and session ids, and a payout's id and kind. Rows for wallets that aren't
 * merchants here, and payouts this server didn't make, are skipped. Every
 * event is checked with polarispay-sdk's validateWebhookEvent before it is
 * stored; a row that fails is refused (and the chain sync still sends the
 * event from its own logs).
 *
 * The cursor (the last row handled) is kept in the store and moves on after
 * each page, so a restart resumes where it stopped; re-reading a row is
 * harmless, its event id is already taken. A read that fails is recorded:
 * webhooks then come from the chain sync alone, `/api/health` lists the
 * problem, and the next read is tried after RETRY_AFTER_ERROR_MS.
 */

export const OUTBOX_PAGE = 5;
const PAGES_PER_PASS = 20;
export const RETRY_AFTER_ERROR_MS = 15_000;
const STATE_ID = "activity";
/** The Activity cursor is blockNumber * 10^8 + logIndex * 100 + slot. */
const BLOCK_STRIDE = 100_000_000n;

let clientOverride: IndexerClient | null = null;

/** Tests: read the outbox from a fake indexer. */
export function setOutboxClientForTests(client: IndexerClient | null): void {
  clientOverride = client;
}

function outboxClient(): IndexerClient | null {
  if (clientOverride) return clientOverride;
  const { indexer, chain } = getConfig();
  if (!indexer.url || !chain) return null;
  return createIndexerClient({
    url: indexer.url,
    chainId: chain.id,
    headers: indexer.token ? { authorization: `Bearer ${indexer.token}` } : undefined,
    timeoutMs: 5_000,
  });
}

/** Whether the dispatcher reads the indexer at all (POLARIS_INDEXER_URL and a chain). */
export function outboxConfigured(): boolean {
  const config = getConfig();
  return clientOverride !== null || (config.indexer.url !== null && config.chain !== null);
}

type Counts = IndexerOutboxRecord["counts"];
type Outcome = { result: keyof Counts; reason?: string };

export type OutboxSummary = {
  /** The cursor this pass started after, and the one it stopped at (decimal strings). */
  from: string;
  cursor: string;
  read: number;
  emitted: number;
  duplicates: number;
  skipped: number;
  rejected: number;
  progressBlock: number | null;
  caughtUp: boolean;
  /** Set when the indexer didn't answer: webhooks come from the chain sync alone. */
  error?: string;
  /** True when this pass didn't read (the last read failed less than RETRY_AFTER_ERROR_MS ago). */
  waiting?: boolean;
};

/** An indexer failure in words, without the endpoint (it can carry a key). */
export function describeIndexerError(error: unknown, url: string | null = getConfig().indexer.url): string {
  let message = error instanceof Error ? error.message : String(error);
  if (url) message = message.split(url).join("POLARIS_INDEXER_URL");
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (let i = 0; i < 3 && cause; i++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return `${message} (${code})`;
    if (cause instanceof Error && cause.name === "AbortError") return `${message} (timed out)`;
    cause = (cause as { cause?: unknown }).cause;
  }
  return message;
}

/** Where to start on the first read: where the chain sync starts, so neither path sends older events. */
async function startingCursor(client: IndexerClient, chain: ChainConfig): Promise<bigint> {
  const from = configuredFromBlock() ?? chain.fromBlock ?? null;
  if (from !== null) return BigInt(from) * BLOCK_STRIDE - 1n;
  // No start block: like the chain sync, no backfill. Everything the indexer has committed so far is history.
  const status = await client.status();
  if (!status || status.progressBlock === null) throw new IndexerError("The indexer has no progress block for this chain yet");
  return BigInt(status.progressBlock + 1) * BLOCK_STRIDE - 1n;
}

const zero = (): Counts => ({ emitted: 0, duplicates: 0, skipped: 0, rejected: 0 });

async function sessionByOrderKey(orderKey: string | null): Promise<CheckoutSessionRecord | null> {
  return orderKey ? getDb().sessions.findOne({ orderKey: orderKey.toLowerCase() }) : null;
}

const sessionOf = (s: CheckoutSessionRecord): WebhookSession => ({ id: s.id, orderId: s.orderId, metadata: s.metadata });

/** One row: its event, built and checked, emitted unless another path already did. */
async function handleRow(a: Activity, chainId: number, merchants: Map<string, MerchantRecord | null>): Promise<Outcome> {
  const db = getDb();
  const key = a.merchant_id.toLowerCase();
  if (!merchants.has(key)) merchants.set(key, await merchantByWallet(key));
  const merchant = merchants.get(key) ?? null;
  if (!merchant) return { result: "skipped", reason: "not a merchant of this server" };

  // An incomplete row (an older indexer's) can't make an event at all.
  try {
    toWebhookEvent(a, { merchantId: merchant.publicId, chainId });
  } catch (error) {
    if (error instanceof IncompleteActivityError) return { result: "rejected", reason: error.message };
    throw error;
  }

  let session: WebhookSession | null = null;
  let automatic = false;
  let sourceKey = webhookSourceKey(a);
  // Fields the chain sync takes from this server's records, which win over the row's.
  const overrides: Record<string, unknown> = {};

  switch (a.kind) {
    case "payment.succeeded":
    case "plan.opened": {
      const record = await sessionByOrderKey(a.orderKey ?? (a.kind === "payment.succeeded" ? a.refId : null));
      if (record) {
        const mismatch = settlementMismatch(record, a.kind === "payment.succeeded" ? { mode: "now", amount: a.amount } : { mode: "later", amount: a.principal ?? 0n });
        // The order is not paid: the chain sync sends nothing a merchant would fulfil on, and neither does this.
        if (mismatch) return { result: "skipped", reason: `settled session ${record.id}'s order without paying it: ${mismatch}` };
        session = sessionOf(record);
      }
      break;
    }
    case "installment.collected":
    case "installment.failed":
    case "plan.completed":
    case "plan.liquidated": {
      const plan = await db.plans.get(a.refId);
      if (plan) overrides.orderId = plan.orderId;
      else {
        const record = await sessionByOrderKey(a.orderKey);
        if (record) session = sessionOf(record);
      }
      break;
    }
    case "subscription.charged": {
      const sub = await db.subscriptions.get(a.refId);
      if (sub) {
        overrides.orderId = sub.orderId;
        overrides.sessionId = sub.sessionId;
        break;
      }
      const record = await sessionByOrderKey(a.orderKey);
      if (record) {
        const mismatch = settlementMismatch(record, {
          mode: "subscribe",
          amount: a.amount,
          planId: a.subscriptionPlanId ?? undefined,
          // The row has no period; hold the session to its own (the chain sync checks it from SubscriptionStarted).
          periodSeconds: record.subscription ? periodSeconds(record.subscription) : undefined,
        });
        if (mismatch) Object.assign(overrides, { orderId: record.orderId ?? a.orderId, sessionId: null });
        else session = sessionOf(record);
      }
      break;
    }
    case "payout.paid": {
      // The API keys a payout on its own record, and sends payout.paid only for payouts it made.
      const payout = await db.payouts.findOne({ txHash: a.txHash.toLowerCase() });
      if (!payout || payout.merchantId !== merchant.id || !payout.txHash) return { result: "skipped", reason: "not a payout this server made" };
      sourceKey = `${payout.txHash}:payout:${payout.id}`;
      automatic = payout.kind === "automatic";
      Object.assign(overrides, { payoutId: payout.id, destination: payout.destination });
      break;
    }
    default:
      break;
  }

  const event = toWebhookEvent(a, { merchantId: merchant.publicId, chainId, session, automatic });
  const id = eventIdFor(sourceKey);
  // The chain sync's id for this chain event: anything else could send it twice.
  if (a.kind !== "payout.paid" && id !== event.id) return { result: "rejected", reason: `event id ${event.id} is not the chain sync's ${id}` };
  const data = { ...event.data, ...overrides };
  const now = new Date();
  const problems = validateWebhookEvent({ id, object: "event", type: event.type, createdAt: now.toISOString(), livemode: false, merchantId: merchant.publicId, data });
  if (problems.length > 0) return { result: "rejected", reason: problems.map((p) => `${p.path} ${p.message}`).join("; ") };

  const { duplicate } = await emitEvent({ merchant, type: event.type, data, sourceKey, source: "indexer", now });
  return { result: duplicate ? "duplicates" : "emitted" };
}

const later = (a: string, b: bigint) => (BigInt(a) >= b ? a : b.toString());

/**
 * Read the outbox from the stored cursor and emit what's new, up to
 * PAGES_PER_PASS pages of OUTBOX_PAGE rows. Null when no indexer is
 * configured. Never throws for the indexer's sake: a failed read is recorded
 * and returned (`error`); a store failure throws.
 */
export async function pollIndexerOutbox(options: { force?: boolean; pages?: number; nowMs?: number } = {}): Promise<OutboxSummary | null> {
  const config = getConfig();
  const client = outboxClient();
  if (!client || !config.chain) return null;
  const chainId = config.chain.id;
  const db = getDb();
  const nowMs = options.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();

  let state = await db.indexerOutbox.get(STATE_ID);
  // A read that answers clears the error, so a stored error means the last read failed.
  const failing = Boolean(state?.error);
  if (!options.force && failing && nowMs - Date.parse(state?.errorAt as string) < RETRY_AFTER_ERROR_MS) {
    const cursor = state?.cursor || "0";
    return { from: cursor, cursor, read: 0, emitted: 0, duplicates: 0, skipped: 0, rejected: 0, progressBlock: state?.progressBlock ?? null, caughtUp: false, error: state?.error ?? undefined, waiting: true };
  }

  const summary: OutboxSummary = { from: state?.cursor || "0", cursor: state?.cursor || "0", read: 0, emitted: 0, duplicates: 0, skipped: 0, rejected: 0, progressBlock: null, caughtUp: false };
  try {
    if (!state || state.cursor === "") {
      const start = (await startingCursor(client, config.chain)).toString();
      state = await db.indexerOutbox.upsert({
        id: STATE_ID,
        cursor: start,
        progressBlock: null,
        polledAt: null,
        okAt: null,
        error: state?.error ?? null,
        errorAt: state?.errorAt ?? null,
        counts: zero(),
        lastRejected: null,
        updatedAt: at,
      });
      summary.from = summary.cursor = start;
    }
    let cursor = BigInt(state.cursor);
    const merchants = new Map<string, MerchantRecord | null>();
    for (let page = 0; page < (options.pages ?? PAGES_PER_PASS); page++) {
      const { activities, progressBlock } = await client.activityAfter(cursor, OUTBOX_PAGE);
      // An indexer of another chain answers, but never with a row for this one: say so rather than wait forever.
      if (progressBlock === null) throw new IndexerError(`The indexer has no progress for chain ${chainId}: is it this chain's indexer?`);
      summary.progressBlock = progressBlock;
      const counts = zero();
      let lastRejected: IndexerOutboxRecord["lastRejected"] = null;
      for (const a of activities) {
        const outcome = await handleRow(a, chainId, merchants);
        counts[outcome.result]++;
        if (outcome.result === "rejected") {
          lastRejected = { cursor: a.cursor.toString(), kind: a.kind, reason: outcome.reason ?? "", at };
          console.warn(`[outbox] refused Activity ${a.cursor} (${a.kind}): ${outcome.reason}`);
        }
      }
      cursor = nextCursor(cursor, activities);
      summary.read += activities.length;
      summary.emitted += counts.emitted;
      summary.duplicates += counts.duplicates;
      summary.skipped += counts.skipped;
      summary.rejected += counts.rejected;
      const next = cursor;
      await db.indexerOutbox.update(STATE_ID, (s) => ({
        ...s,
        // Two readers (the loop and the cron route) can overlap: the cursor only moves forward.
        cursor: later(s.cursor, next),
        progressBlock,
        polledAt: at,
        okAt: at,
        error: null,
        errorAt: null,
        counts: {
          emitted: s.counts.emitted + counts.emitted,
          duplicates: s.counts.duplicates + counts.duplicates,
          skipped: s.counts.skipped + counts.skipped,
          rejected: s.counts.rejected + counts.rejected,
        },
        lastRejected: lastRejected ?? s.lastRejected,
        updatedAt: at,
      }));
      if (activities.length < OUTBOX_PAGE) {
        summary.caughtUp = true;
        break;
      }
    }
    summary.cursor = cursor.toString();
    if (failing) console.log("[outbox] the Envio indexer answers again: webhooks come from its outbox, with the chain sync as backup");
    return summary;
  } catch (error) {
    if (!(error instanceof IndexerError)) throw error;
    const message = describeIndexerError(error, config.indexer.url);
    if (!failing) console.warn(`[outbox] the Envio indexer didn't answer (${message}): webhooks come from the chain sync until it does`);
    const fallback: IndexerOutboxRecord = {
      id: STATE_ID,
      // Not started: the first read that answers picks the starting cursor.
      cursor: "",
      progressBlock: null,
      polledAt: at,
      okAt: null,
      error: message,
      errorAt: at,
      counts: zero(),
      lastRejected: null,
      updatedAt: at,
    };
    const saved = await db.indexerOutbox.update(STATE_ID, (s) => ({ ...s, polledAt: at, error: message, errorAt: at, updatedAt: at }));
    if (!saved) await db.indexerOutbox.upsert(fallback);
    return { ...summary, error: message };
  }
}

/** Where webhooks come from right now, for /api/health and the dashboard. */
export type OutboxHealth = {
  /** "chain-sync": no indexer configured; "indexer": its outbox, with the chain sync as backup; "fallback": its last read failed. */
  mode: "chain-sync" | "indexer" | "fallback";
  cursor: string | null;
  progressBlock: number | null;
  polledAt: string | null;
  okAt: string | null;
  error: string | null;
  counts: Counts | null;
  lastRejected: IndexerOutboxRecord["lastRejected"];
  /** A sentence for the operator's problem list, or null. */
  problem: string | null;
};

export async function outboxHealth(): Promise<OutboxHealth> {
  const none = { cursor: null, progressBlock: null, polledAt: null, okAt: null, error: null, counts: null, lastRejected: null, problem: null };
  if (!outboxConfigured()) return { mode: "chain-sync", ...none };
  const state = await getDb().indexerOutbox.get(STATE_ID);
  if (!state) return { mode: "indexer", ...none };
  const failing = state.error !== null;
  return {
    mode: failing ? "fallback" : "indexer",
    cursor: state.cursor || null,
    progressBlock: state.progressBlock,
    polledAt: state.polledAt,
    okAt: state.okAt,
    error: failing ? state.error : null,
    counts: state.counts,
    lastRejected: state.lastRejected,
    problem: failing
      ? `The Envio indexer (POLARIS_INDEXER_URL) didn't answer at ${state.errorAt}: ${state.error}. Webhooks come from the chain sync alone until it does.`
      : null,
  };
}
