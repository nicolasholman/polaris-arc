/**
 * A per-event unit of work over Envio's entity store.
 *
 * Handlers load entities through a Store, change them as plain mutable
 * objects, and `flush()` once at the end. Loading the same row twice returns
 * the same object, so two helpers can never overwrite each other's changes
 * with a stale copy. Every row loaded through a helper is written at flush.
 *
 * Envio runs each handler twice (a preload pass that only reads, then the
 * real pass), so nothing here throws on a missing row, and nothing talks to
 * the outside world.
 */

import type { Entity, EntityName, EvmOnEventContext } from "envio";

import { settingsFor, type ChainSettings } from "../deployment.js";
import { creditLimitOf, baseLimitOf, STARTING_SCORE } from "./credit.js";
import { cursorOf, dateOf, dayOf, PROTOCOL_ID, type WebhookKind } from "./util.js";

export type Mut<T> = { -readonly [K in keyof T]: T[K] };

export type Protocol = Mut<Entity<"Protocol">>;
export type Merchant = Mut<Entity<"Merchant">>;
export type Buyer = Mut<Entity<"Buyer">>;
export type MerchantDay = Mut<Entity<"MerchantDay">>;
export type ProtocolDay = Mut<Entity<"ProtocolDay">>;
export type BuyerDay = Mut<Entity<"BuyerDay">>;
export type Customer = Mut<Entity<"Customer">>;
export type Plan = Mut<Entity<"Plan">>;
export type Installment = Mut<Entity<"Installment">>;
export type Subscription = Mut<Entity<"Subscription">>;
export type SubscriptionPlan = Mut<Entity<"SubscriptionPlan">>;
export type Order = Mut<Entity<"Order">>;
export type Payment = Mut<Entity<"Payment">>;
export type Send = Mut<Entity<"Send">>;
export type Activity = Mut<Entity<"Activity">>;

/** What every handler needs to know about the log it is handling. */
export type Meta = {
  readonly chainId: number;
  readonly blockNumber: number;
  readonly timestamp: number;
  readonly logIndex: number;
  readonly txHash: string;
  /** The transaction's sender: the relayer, the CRE transmitter, or a keeper. */
  readonly from: string;
  /** The transaction's target contract. */
  readonly to: string | undefined;
  readonly srcAddress: string;
  readonly day: number;
};

type LogLike = {
  readonly chainId: number;
  readonly srcAddress: string;
  readonly logIndex: number;
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly transaction: { readonly hash: string; readonly from: string | undefined; readonly to: string | undefined };
};

export function metaOf(event: LogLike): Meta {
  return {
    chainId: event.chainId,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    logIndex: event.logIndex,
    txHash: event.transaction.hash.toLowerCase(),
    from: (event.transaction.from ?? "").toLowerCase(),
    to: event.transaction.to?.toLowerCase(),
    srcAddress: event.srcAddress.toLowerCase(),
    day: dayOf(event.block.timestamp),
  };
}

type Ops = {
  readonly get: (id: string) => Promise<unknown>;
  readonly set: (entity: never) => void;
};

export class Store {
  readonly settings: ChainSettings;
  private readonly rows = new Map<string, Map<string, object>>();
  private readonly order: Array<[EntityName, string]> = [];

  constructor(
    readonly ctx: EvmOnEventContext,
    readonly m: Meta,
  ) {
    this.settings = settingsFor(m.chainId);
  }

  private ops(name: EntityName): Ops {
    return (this.ctx as unknown as Record<string, Ops>)[name]!;
  }

  /** Load a row, or undefined. The same object comes back on every call. */
  async find<N extends EntityName>(name: N, id: string): Promise<Mut<Entity<N>> | undefined> {
    const table = this.rows.get(name);
    const cached = table?.get(id);
    if (cached) return cached as Mut<Entity<N>>;
    const row = (await this.ops(name).get(id)) as Entity<N> | undefined;
    if (!row) return undefined;
    return this.keep(name, { ...row } as Mut<Entity<N>>);
  }

  /** Load a row, or create it from `make()`. Either way it is written at flush. */
  async upsert<N extends EntityName>(name: N, id: string, make: () => Entity<N>): Promise<{ row: Mut<Entity<N>>; created: boolean }> {
    const found = await this.find(name, id);
    if (found) return { row: found, created: false };
    return { row: this.keep(name, { ...make() } as Mut<Entity<N>>), created: true };
  }

  /** Stage a row to be written at flush (new or changed). */
  keep<N extends EntityName, R extends object>(name: N, row: R): R {
    const id = (row as { id: string }).id;
    let table = this.rows.get(name);
    if (!table) {
      table = new Map();
      this.rows.set(name, table);
    }
    if (!table.has(id)) this.order.push([name, id]);
    table.set(id, row);
    return row;
  }

  flush(): void {
    for (const [name, id] of this.order) {
      const row = this.rows.get(name)?.get(id);
      if (row) this.ops(name).set(row as never);
    }
  }

  /* ── The rows almost every handler touches ─────────────────────────── */

  async protocol(): Promise<Protocol> {
    const s = this.settings;
    const { row } = await this.upsert("Protocol", PROTOCOL_ID, () => ({
      id: PROTOCOL_ID,
      feeBps: s.feeBps,
      requireUnderwriting: s.requireUnderwriting,
      // CollateralVault's default; MultiplierChanged updates it.
      collateralMultiplierBps: 15_000,
      // The deploy script always points ScoreManager at the vault, so this is
      // right even when ENVIO_START_BLOCK skips the CollateralVaultSet event.
      collateralCountsTowardLimits: true,
      checkoutPaused: false,
      merchantCount: 0,
      registeredMerchantCount: 0,
      buyerCount: 0,
      paymentCount: 0,
      grossVolume: 0n,
      feeVolume: 0n,
      payNowCount: 0,
      payNowVolume: 0n,
      planCount: 0,
      activePlanCount: 0,
      principalOriginated: 0n,
      outstanding: 0n,
      repaidVolume: 0n,
      installmentsCompleted: 0,
      creCollections: 0,
      liquidationCount: 0,
      lossVolume: 0n,
      subscriptionCount: 0,
      activeSubscriptionCount: 0,
      subscriptionVolume: 0n,
      sendCount: 0,
      sendVolume: 0n,
      claimCount: 0,
      claimVolume: 0n,
      payoutCount: 0,
      payoutVolume: 0n,
      collectionsRuns: 0,
      lastCollectionsRunAt: undefined,
      lastCollectionsRunBlock: undefined,
      creReports: 0,
      creReportsFailed: 0,
      underwritings: 0,
      updatedAt: this.m.timestamp,
    }));
    row.updatedAt = this.m.timestamp;
    return row;
  }

  async protocolDay(): Promise<ProtocolDay> {
    const day = this.m.day;
    const { row } = await this.upsert("ProtocolDay", String(day), () => ({
      id: String(day),
      day,
      date: dateOf(day),
      paymentCount: 0,
      grossVolume: 0n,
      feeVolume: 0n,
      planCount: 0,
      principalOriginated: 0n,
      installmentsCompleted: 0,
      repaidVolume: 0n,
      liquidations: 0,
      subscriptionCharges: 0,
      subscriptionVolume: 0n,
      sendCount: 0,
      sendVolume: 0n,
      claimCount: 0,
      payoutCount: 0,
      payoutVolume: 0n,
      collectionsRuns: 0,
      creReports: 0,
      newBuyers: 0,
      newMerchants: 0,
      open: undefined,
      high: undefined,
      low: undefined,
      close: undefined,
    }));
    return row;
  }

  /** A merchant row, created on first sight (which also counts it). */
  async merchant(address: string): Promise<Merchant> {
    const id = address.toLowerCase();
    const { row, created } = await this.upsert("Merchant", id, () => ({
      id,
      registered: false,
      name: undefined,
      payoutAddress: undefined,
      active: false,
      maxOrderValue: undefined,
      registeredAt: undefined,
      registeredBy: undefined,
      settlementRecorded: 0n,
      paymentCount: 0,
      grossVolume: 0n,
      feeVolume: 0n,
      netVolume: 0n,
      payNowCount: 0,
      payNowVolume: 0n,
      planCount: 0,
      planVolume: 0n,
      subscriptionChargeCount: 0,
      subscriptionVolume: 0n,
      customerCount: 0,
      activePlanCount: 0,
      outstanding: 0n,
      dunningPlanCount: 0,
      atRiskOutstanding: 0n,
      repaidPlanCount: 0,
      liquidatedPlanCount: 0,
      activeSubscriptionCount: 0,
      mrr: 0n,
      balance: 0n,
      payoutCount: 0,
      payoutVolume: 0n,
      firstSeenAt: this.m.timestamp,
      lastPaymentAt: undefined,
      updatedAt: this.m.timestamp,
    }));
    if (created) {
      (await this.protocol()).merchantCount += 1;
      (await this.protocolDay()).newMerchants += 1;
    }
    row.updatedAt = this.m.timestamp;
    return row;
  }

  /** A Polaris app account, created on first sight (which also counts it). */
  async buyer(address: string): Promise<Buyer> {
    const id = address.toLowerCase();
    const { row, created } = await this.upsert("Buyer", id, () => ({
      id,
      score: STARTING_SCORE,
      hasRecord: false,
      underwritten: false,
      declined: false,
      baseLimit: 0n,
      collateral: 0n,
      creditLimit: 0n,
      activeDebt: 0n,
      available: 0n,
      linkedWallet: undefined,
      underwrittenAt: undefined,
      lastUnderwritingRefusal: undefined,
      onTimeInstallments: 0,
      lateInstallments: 0,
      liquidations: 0,
      planCount: 0,
      activePlanCount: 0,
      paymentCount: 0,
      spent: 0n,
      activeSubscriptionCount: 0,
      sentCount: 0,
      sentVolume: 0n,
      claimedCount: 0,
      claimedVolume: 0n,
      firstSeenAt: this.m.timestamp,
      updatedAt: this.m.timestamp,
    }));
    if (created) {
      (await this.protocol()).buyerCount += 1;
      (await this.protocolDay()).newBuyers += 1;
      await this.refreshCredit(row);
    }
    row.updatedAt = this.m.timestamp;
    return row;
  }

  /** Recompute a buyer's line from its inputs and the protocol's settings. */
  async refreshCredit(buyer: Buyer): Promise<void> {
    const p = await this.protocol();
    const settings = {
      requireUnderwriting: p.requireUnderwriting,
      collateralCountsTowardLimits: p.collateralCountsTowardLimits,
      collateralMultiplierBps: p.collateralMultiplierBps,
    };
    buyer.baseLimit = baseLimitOf(buyer, settings);
    buyer.creditLimit = creditLimitOf(buyer, settings);
    buyer.available = buyer.creditLimit > buyer.activeDebt ? buyer.creditLimit - buyer.activeDebt : 0n;
  }

  async merchantDay(merchant: Merchant): Promise<MerchantDay> {
    const day = this.m.day;
    const { row } = await this.upsert("MerchantDay", `${merchant.id}-${day}`, () => ({
      id: `${merchant.id}-${day}`,
      merchant_id: merchant.id,
      day,
      date: dateOf(day),
      paymentCount: 0,
      grossVolume: 0n,
      feeVolume: 0n,
      netVolume: 0n,
      payNowCount: 0,
      payNowVolume: 0n,
      planCount: 0,
      planVolume: 0n,
      subscriptionChargeCount: 0,
      subscriptionVolume: 0n,
      installmentsCompleted: 0,
      repaidVolume: 0n,
      failedCollections: 0,
      newCustomers: 0,
      payoutCount: 0,
      payoutVolume: 0n,
      open: undefined,
      high: undefined,
      low: undefined,
      close: undefined,
      balanceOpen: merchant.balance,
      balanceHigh: merchant.balance,
      balanceLow: merchant.balance,
      balanceClose: merchant.balance,
    }));
    return row;
  }

  async buyerDay(buyer: Buyer): Promise<BuyerDay> {
    const day = this.m.day;
    const { row } = await this.upsert("BuyerDay", `${buyer.id}-${day}`, () => ({
      id: `${buyer.id}-${day}`,
      buyer_id: buyer.id,
      day,
      date: dateOf(day),
      scoreOpen: buyer.score,
      scoreHigh: buyer.score,
      scoreLow: buyer.score,
      scoreClose: buyer.score,
      spent: 0n,
      repaid: 0n,
    }));
    return row;
  }

  /** The merchant x buyer row; returns whether this is the buyer's first payment to them. */
  async customer(merchant: Merchant, buyer: Buyer, amount: bigint): Promise<boolean> {
    const id = `${merchant.id}-${buyer.id}`;
    const { row, created } = await this.upsert("Customer", id, () => ({
      id,
      merchant_id: merchant.id,
      buyer_id: buyer.id,
      firstPaidAt: this.m.timestamp,
      lastPaidAt: this.m.timestamp,
      paymentCount: 0,
      volume: 0n,
    }));
    row.paymentCount += 1;
    row.volume += amount;
    row.lastPaidAt = this.m.timestamp;
    if (created) merchant.customerCount += 1;
    return created;
  }

  /** Add a row to the webhook outbox. `slot` separates two activities from one log. */
  activity(kind: WebhookKind, merchantId: string, fields: Partial<Omit<Activity, "id" | "cursor" | "kind">> & { refId: string; amount: bigint }, slot = 0): Activity {
    const cursor = cursorOf(this.m.blockNumber, this.m.logIndex, slot);
    const row: Activity = {
      id: cursor.toString(),
      cursor,
      kind,
      merchant_id: merchantId,
      buyer: undefined,
      orderId: undefined,
      orderKey: undefined,
      mode: undefined,
      fee: undefined,
      installmentIndex: undefined,
      installmentCount: undefined,
      principal: undefined,
      interval: undefined,
      firstDueAt: undefined,
      remaining: undefined,
      recovered: undefined,
      attempt: undefined,
      nextAttemptAt: undefined,
      failureReason: undefined,
      subscriptionPlanId: undefined,
      period: undefined,
      nextChargeAt: undefined,
      canceledBy: undefined,
      reason: undefined,
      reasonAction: undefined,
      destination: undefined,
      timestamp: this.m.timestamp,
      blockNumber: this.m.blockNumber,
      logIndex: this.m.logIndex,
      txHash: this.m.txHash,
      ...fields,
    };
    return this.keep("Activity", row);
  }

  warn(message: string): void {
    if (!this.ctx.isPreload) this.ctx.log.warn(message);
  }
}

/** Record a payment amount in a day's candle (first, largest, smallest, last). */
export function candle(day: { open?: bigint; high?: bigint; low?: bigint; close?: bigint }, amount: bigint): void {
  if (day.open === undefined) day.open = amount;
  if (day.high === undefined || amount > day.high) day.high = amount;
  if (day.low === undefined || amount < day.low) day.low = amount;
  day.close = amount;
}

/** Record a balance level in a merchant's day. */
export function balanceTick(day: MerchantDay, balance: bigint): void {
  if (balance > day.balanceHigh) day.balanceHigh = balance;
  if (balance < day.balanceLow) day.balanceLow = balance;
  day.balanceClose = balance;
}

/** Record a score level in a buyer's day. */
export function scoreTick(day: BuyerDay, score: number): void {
  if (score > day.scoreHigh) day.scoreHigh = score;
  if (score < day.scoreLow) day.scoreLow = score;
  day.scoreClose = score;
}

/** Run a handler body as one unit of work. */
export async function withStore(ctx: EvmOnEventContext, event: LogLike, body: (st: Store) => Promise<void>): Promise<void> {
  const st = new Store(ctx, metaOf(event));
  await body(st);
  st.flush();
}
