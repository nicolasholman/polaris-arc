/**
 * The typed client: one method per question a screen, the webhook
 * dispatcher or a script asks the indexer. Addresses may be passed in any
 * case; the indexer stores them lowercase.
 */

import { dueCandidatesRequest, parseDueCandidates, type Task } from "./cre.ts";
import { decode, type Raw } from "./decode.ts";
import * as D from "./documents.ts";
import { createTransport, IndexerError, type Request, type TransportOptions } from "./http.ts";
import type {
  Activity,
  Buyer,
  BuyerDay,
  CollectionRun,
  CollectionTask,
  CreReport,
  Customer,
  IndexerStatus,
  Merchant,
  MerchantDay,
  Order,
  Payment,
  PaymentMode,
  Payout,
  Plan,
  PlanStatus,
  Protocol,
  ProtocolDay,
  Repayment,
  ScoreEvent,
  Send,
  Subscription,
  SubscriptionStatus,
} from "./types.ts";
import { committed } from "./webhooks.ts";

export type IndexerClientOptions = TransportOptions & {
  /** The chain whose `_meta` row to read (default 10143, Monad testnet). */
  chainId?: number;
  /** The clock, for "the last N days" windows. Defaults to Date.now. */
  now?: () => number;
};

export type Page = { limit?: number; offset?: number };

const SECONDS_PER_DAY = 86_400;
const lower = (a: string) => a.toLowerCase();

export type IndexerClient = ReturnType<typeof createIndexerClient>;

export function createIndexerClient(options: IndexerClientOptions) {
  const request: Request = createTransport(options);
  const chainId = options.chainId ?? 10143;
  const nowSeconds = () => Math.floor((options.now ?? Date.now)() / 1000);
  const dayNow = () => Math.floor(nowSeconds() / SECONDS_PER_DAY);
  const page = (p: Page = {}) => ({ limit: p.limit ?? 50, offset: p.offset ?? 0 });
  const one = <T>(list: unknown, fn: (r: Raw) => T): T | null => decode.rows(list, fn)[0] ?? null;

  const api = {
    /** Send any document (e.g. one from ./documents) and get the raw data back. */
    request,

    /** How far the indexer has got. */
    async status(): Promise<IndexerStatus | null> {
      const data = await request<{ _meta: unknown }>(D.INDEXER_STATUS);
      return decode.status(data._meta, chainId);
    },

    /* ── Dashboard ─────────────────────────────────────────────────────── */

    async merchantOverview(merchant: string, opts: { days?: number; recent?: number } = {}) {
      const data = await request<{ Merchant: Raw[]; recentPayments: Raw[]; days: Raw[] }>(D.MERCHANT_OVERVIEW, {
        merchant: lower(merchant),
        fromDay: dayNow() - (opts.days ?? 30) + 1,
        recent: opts.recent ?? 6,
      });
      return {
        merchant: one<Merchant>(data.Merchant, decode.merchant),
        recentPayments: decode.rows<Payment>(data.recentPayments, decode.payment),
        days: decode.rows<MerchantDay>(data.days, decode.merchantDay),
      };
    },

    async payments(merchant: string, opts: Page & { mode?: PaymentMode; buyer?: string; since?: number } = {}): Promise<Payment[]> {
      const where: Raw = { merchant_id: { _eq: lower(merchant) } };
      if (opts.mode) where.mode = { _eq: opts.mode };
      if (opts.buyer) where.buyer_id = { _eq: lower(opts.buyer) };
      if (opts.since !== undefined) where.timestamp = { _gte: opts.since };
      const data = await request<{ Payment: Raw[] }>(D.MERCHANT_PAYMENTS, { where, ...page(opts) });
      return decode.rows(data.Payment, decode.payment);
    },

    /** The Pay in 4 ledger. `filter` mirrors the dashboard's tabs. */
    async plans(merchant: string, opts: Page & { filter?: "all" | "collecting" | "dunning" | "closed"; status?: PlanStatus } = {}): Promise<Plan[]> {
      const where: Raw = { merchant_id: { _eq: lower(merchant) } };
      if (opts.status) where.status = { _eq: opts.status };
      if (opts.filter === "collecting") Object.assign(where, { status: { _eq: "ACTIVE" }, dunning: { _eq: false } });
      if (opts.filter === "dunning") Object.assign(where, { status: { _eq: "ACTIVE" }, dunning: { _eq: true } });
      if (opts.filter === "closed") where.status = { _in: ["REPAID", "LIQUIDATED"] };
      const data = await request<{ Plan: Raw[] }>(D.MERCHANT_PLANS, { where, ...page(opts) });
      return decode.rows(data.Plan, decode.plan);
    },

    async plan(loanId: bigint | number | string): Promise<{ plan: Plan; repayments: Repayment[]; collections: CollectionTask[] } | null> {
      const id = BigInt(loanId).toString();
      const data = await request<{ Plan: Raw[]; CollectionTask: Raw[] }>(D.PLAN_DETAIL, { loanId: id, loanIdNumeric: id });
      const raw = data.Plan[0];
      if (!raw) return null;
      return {
        plan: decode.plan(raw),
        repayments: decode.rows(raw.repayments, decode.repayment),
        collections: decode.rows(data.CollectionTask, decode.collectionTask),
      };
    },

    async subscriptions(merchant: string, opts: Page & { status?: SubscriptionStatus } = {}): Promise<Subscription[]> {
      const where: Raw = { merchant_id: { _eq: lower(merchant) } };
      if (opts.status) where.status = { _eq: opts.status };
      const data = await request<{ Subscription: Raw[] }>(D.MERCHANT_SUBSCRIPTIONS, { where, ...page(opts) });
      return decode.rows(data.Subscription, decode.subscription);
    },

    async payouts(merchant: string, opts: Page = {}): Promise<Payout[]> {
      const data = await request<{ Payout: Raw[] }>(D.MERCHANT_PAYOUTS, { merchant: lower(merchant), ...page(opts) });
      return decode.rows(data.Payout, decode.payout);
    },

    async customers(merchant: string, opts: Page = {}): Promise<Customer[]> {
      const data = await request<{ Customer: Raw[] }>(D.MERCHANT_CUSTOMERS, { merchant: lower(merchant), ...page(opts) });
      return decode.rows(data.Customer, decode.customer);
    },

    /** Days `fromDay`..`toDay` (days since the epoch, UTC); only days with activity have rows. */
    async merchantDays(merchant: string, fromDay: number, toDay = dayNow()): Promise<MerchantDay[]> {
      const data = await request<{ MerchantDay: Raw[] }>(D.MERCHANT_DAYS, { merchant: lower(merchant), fromDay, toDay });
      return decode.rows(data.MerchantDay, decode.merchantDay);
    },

    /** An order key's settlement: null until the indexer has seen it quoted or paid. */
    async order(orderKey: string): Promise<Order | null> {
      const data = await request<{ Order: Raw[] }>(D.ORDER_STATUS, { orderKey: lower(orderKey) });
      return one(data.Order, decode.order);
    },

    /**
     * Wait until an order is PAID in the index ("Paid" only ever comes from an
     * indexed chain event). Resolves with the order, or null on timeout.
     */
    async waitForOrder(orderKey: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Order | null> {
      const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
      const interval = opts.intervalMs ?? 400;
      for (;;) {
        const order = await api.order(orderKey);
        if (order?.status === "PAID") return order;
        if (Date.now() + interval > deadline) return null;
        await new Promise((r) => setTimeout(r, interval));
      }
    },

    async collector(opts: { runs?: number } = {}): Promise<{ protocol: Protocol | null; runs: CollectionRun[]; reports: CreReport[] }> {
      const data = await request<{ Protocol: Raw[]; CollectionRun: Raw[]; CreReport: Raw[] }>(D.COLLECTOR_STATUS, { runs: opts.runs ?? 5 });
      return {
        protocol: one(data.Protocol, decode.protocol),
        runs: decode.rows(data.CollectionRun, decode.collectionRun),
        reports: decode.rows(data.CreReport, decode.creReport),
      };
    },

    async protocolStats(opts: { days?: number } = {}): Promise<{ protocol: Protocol | null; days: ProtocolDay[] }> {
      const data = await request<{ Protocol: Raw[]; ProtocolDay: Raw[] }>(D.PROTOCOL_STATS, { fromDay: dayNow() - (opts.days ?? 30) + 1 });
      return { protocol: one(data.Protocol, decode.protocol), days: decode.rows(data.ProtocolDay, decode.protocolDay) };
    },

    /* ── Webhooks ──────────────────────────────────────────────────────── */

    /**
     * The next page of the webhook outbox after `after` (0n to start), only
     * rows the indexer has committed. Store the last delivered cursor and
     * pass it back (see nextCursor in ./webhooks).
     */
    async activityAfter(after: bigint, limit = 100): Promise<{ activities: Activity[]; progressBlock: number | null }> {
      const data = await request<{ Activity: Raw[]; _meta: unknown }>(D.ACTIVITY_AFTER, { after, limit });
      const progressBlock = decode.status(data._meta, chainId)?.progressBlock ?? null;
      return { activities: committed(decode.rows(data.Activity, decode.activity), progressBlock), progressBlock };
    },

    /** A merchant's own events, newest first (the dashboard's event log). */
    async merchantActivity(merchant: string, opts: { before?: bigint; limit?: number } = {}): Promise<Activity[]> {
      const data = await request<{ Activity: Raw[] }>(D.MERCHANT_ACTIVITY, {
        merchant: lower(merchant),
        before: opts.before ?? 10n ** 30n,
        limit: opts.limit ?? 50,
      });
      return decode.rows(data.Activity, decode.activity);
    },

    /* ── CRE (for scripts and the fallback keeper; the workflow uses ./cre directly) ── */

    async dueCandidates(now = nowSeconds(), limit = 50): Promise<Task[]> {
      const { query, variables } = dueCandidatesRequest(now, limit);
      return parseDueCandidates(await request(query, variables), now);
    },

    /* ── The Polaris app ───────────────────────────────────────────────── */

    async buyerHome(buyer: string, opts: { days?: number } = {}) {
      const data = await request<{ Buyer: Raw[]; Plan: Raw[]; Subscription: Raw[]; Protocol: Raw[] }>(D.BUYER_HOME, {
        buyer: lower(buyer),
        fromDay: dayNow() - (opts.days ?? 90) + 1,
      });
      const raw = data.Buyer[0];
      return {
        buyer: raw ? decode.buyer(raw) : null,
        scoreEvents: raw ? decode.rows<ScoreEvent>(raw.scoreEvents, decode.scoreEvent) : [],
        days: raw ? decode.rows<BuyerDay>(raw.days, decode.buyerDay) : [],
        plans: decode.rows(data.Plan, decode.plan),
        subscriptions: decode.rows(data.Subscription, decode.subscription),
        settings: (data.Protocol[0] as { requireUnderwriting: boolean; collateralMultiplierBps: number; collateralCountsTowardLimits: boolean } | undefined) ?? null,
      };
    },

    async buyerActivity(buyer: string, limit = 50): Promise<{ payments: Payment[]; sent: Send[]; received: Send[] }> {
      const data = await request<{ Payment: Raw[]; sent: Raw[]; received: Raw[] }>(D.BUYER_ACTIVITY, { buyer: lower(buyer), limit });
      return {
        payments: decode.rows(data.Payment, decode.payment),
        sent: decode.rows(data.sent, decode.send),
        received: decode.rows(data.received, decode.send),
      };
    },

    async send(linkKey: string): Promise<Send | null> {
      const data = await request<{ Send: Raw[] }>(D.SEND_BY_KEY, { linkKey: lower(linkKey) });
      return one(data.Send, decode.send);
    },

    async merchant(merchant: string): Promise<Merchant | null> {
      return (await api.merchantOverview(merchant, { days: 1, recent: 0 })).merchant;
    },

    async buyer(buyer: string): Promise<Buyer | null> {
      return (await api.buyerHome(buyer, { days: 1 })).buyer;
    },
  };
  return api;
}

export { IndexerError };
