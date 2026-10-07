import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSqliteStore, type MerchantRecord } from "@polaris/db";
import { createIndexerClient, type Activity, type FetchLike, type IndexerClient, type WebhookKind } from "@polarispay/indexer-client";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectionsReceiverAbi, polarisLoanEngineAbi } from "@polarispay/contracts/abi";
import { GET as health } from "@/app/api/health/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { GET as listWebhooks } from "@/app/api/webhooks/route";
import { getDb, replaceStoreForTests } from "@/server/db";
import { syncChain } from "@/server/ingest/sync";
import { TYPES } from "@/server/relayer/typed-data";
import { dispatchDue } from "@/server/webhooks/dispatcher";
import { eventIdFor } from "@/server/webhooks/events";
import { OUTBOX_PAGE, outboxHealth, pollIndexerOutbox, RETRY_AFTER_ERROR_MS, setOutboxClientForTests } from "@/server/webhooks/outbox";
import { runTick } from "@/server/workers";

import { validateWebhookEvent } from "../../../packages/sdk/src/event-shape";
import { verifyWebhook } from "../../../packages/sdk/src/server/webhooks";
import { makeLog, type LogSpec } from "./helpers/fake-chain";
import { ADDR, json, params, request, setupServer, signIn, type TestEnv } from "./helpers/env";
import { checkoutDomain, emitLikeTheContracts, inSeconds, merchantWithKeys, newSession, orderKey, type Merchant } from "./helpers/flows";

/**
 * The webhook dispatcher reading the Envio indexer's Activity outbox
 * (src/server/webhooks/outbox.ts), against a test double of the indexer's
 * GraphQL endpoint: Hasura's answers for the client's own ActivityAfter and
 * IndexerStatus documents, BigInt columns as strings, `_meta` per chain, and
 * only rows at or below the progress block committed.
 */

const INDEXER_URL = "http://indexer.test/v1/graphql";
const STRIDE = 100_000_000n;

type FakeIndexer = {
  rows: Activity[];
  progressBlock: number | null;
  down: boolean;
  /** Every ActivityAfter page asked for: the cursor after which, and how many. */
  pages: Array<{ after: string; limit: number }>;
  statusCalls: number;
  client: IndexerClient;
  publish: (...rows: Activity[]) => void;
};

function fakeIndexer(): FakeIndexer {
  const f = { rows: [] as Activity[], progressBlock: 100 as number | null, down: false, pages: [] as FakeIndexer["pages"], statusCalls: 0 } as FakeIndexer;
  const raw = (a: Activity) => JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const fetch: FetchLike = async (_url, init) => {
    if (f.down) throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ECONNREFUSED ${INDEXER_URL}`), { code: "ECONNREFUSED" }) });
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const meta = f.progressBlock === null ? [] : [{ chainId: 31337, progressBlock: f.progressBlock, sourceBlock: f.progressBlock, eventsProcessed: f.rows.length, isReady: true, readyAt: null, startBlock: 1 }];
    let data: unknown;
    if (query.includes("query ActivityAfter")) {
      const after = BigInt(variables.after as string);
      f.pages.push({ after: String(variables.after), limit: Number(variables.limit) });
      const page = f.rows
        .filter((r) => r.cursor > after)
        .sort((a, b) => (a.cursor < b.cursor ? -1 : 1))
        .slice(0, Number(variables.limit))
        .map(raw);
      data = { Activity: page, _meta: meta };
    } else if (query.includes("query IndexerStatus")) {
      f.statusCalls++;
      data = { _meta: meta };
    } else {
      const body = { errors: [{ message: "not a document the outbox sends" }] };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) };
  };
  f.client = createIndexerClient({ url: INDEXER_URL, chainId: 31337, fetch });
  f.publish = (...rows) => {
    f.rows.push(...rows);
    f.progressBlock = Math.max(f.progressBlock ?? 0, ...rows.map((r) => r.blockNumber));
  };
  return f;
}

/** A row as the indexer writes it. */
function activity(kind: WebhookKind, fields: Partial<Activity> & { merchant: string; blockNumber: number; txHash: string; logIndex?: number; slot?: number }): Activity {
  const logIndex = fields.logIndex ?? 0;
  const cursor = BigInt(fields.blockNumber) * STRIDE + BigInt(logIndex) * 100n + BigInt(fields.slot ?? 0);
  const { merchant, slot, ...rest } = fields;
  void slot;
  return {
    id: cursor.toString(),
    cursor,
    kind,
    merchant_id: merchant.toLowerCase(),
    buyer: null,
    orderId: null,
    orderKey: null,
    mode: null,
    amount: 0n,
    fee: null,
    refId: "1",
    installmentIndex: null,
    installmentCount: null,
    principal: null,
    interval: null,
    firstDueAt: null,
    remaining: null,
    recovered: null,
    attempt: null,
    nextAttemptAt: null,
    failureReason: null,
    subscriptionPlanId: null,
    period: null,
    nextChargeAt: null,
    canceledBy: null,
    reason: null,
    reasonAction: null,
    destination: null,
    timestamp: 1_790_000_000,
    logIndex,
    ...rest,
  };
}

const txOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

let env: TestEnv;
let merchant: Merchant;
let record: MerchantRecord;
let indexer: FakeIndexer;
const buyer = privateKeyToAccount(generatePrivateKey());

beforeEach(async () => {
  env = setupServer({ POLARIS_INDEXER_URL: INDEXER_URL });
  emitLikeTheContracts(env);
  merchant = await merchantWithKeys({ webhook: true });
  record = (await getDb().merchants.get(merchant.userId)) as MerchantRecord;
  indexer = fakeIndexer();
  setOutboxClientForTests(indexer.client);
});

afterEach(() => setOutboxClientForTests(null));

/** Pay now rows for this merchant, one per block from 101. */
function payments(count: number): Activity[] {
  return Array.from({ length: count }, (_, i) =>
    activity("payment.succeeded", {
      merchant: merchant.account.address,
      blockNumber: 101 + i,
      txHash: txOf(0xa000 + i),
      logIndex: 1,
      refId: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      orderId: `order-${i + 1}`,
      buyer: buyer.address.toLowerCase(),
      amount: 25_000_000n,
      fee: 125_000n,
      mode: "PAY_NOW",
    }),
  );
}

async function storedEvents(source?: string) {
  const events = await getDb().webhookEvents.find({ merchantId: record.id });
  return events.filter((e) => source === undefined || e.source === source);
}

describe("the outbox, page by page", () => {
  it("reads five rows a page in cursor order, emits each as the SDK's event, and keeps the cursor after each page", async () => {
    // No start block configured (the fixture deployment has none): the first read starts after the indexer's progress, block 100.
    expect(await pollIndexerOutbox()).toMatchObject({ read: 0, from: (101n * STRIDE - 1n).toString() });
    indexer.pages.length = 0;
    const rows = payments(12);
    indexer.publish(...rows);
    const summary = await pollIndexerOutbox();
    expect(summary).toMatchObject({ read: 12, emitted: 12, duplicates: 0, skipped: 0, rejected: 0, caughtUp: true, progressBlock: 112 });
    expect(indexer.pages.map((p) => p.limit)).toEqual([OUTBOX_PAGE, OUTBOX_PAGE, OUTBOX_PAGE]);
    expect(indexer.pages.map((p) => BigInt(p.after))).toEqual([101n * STRIDE - 1n, rows[4]!.cursor, rows[9]!.cursor]);
    expect((await getDb().indexerOutbox.get("activity"))?.cursor).toBe(rows[11]!.cursor.toString());

    const events = await storedEvents("indexer");
    expect(events).toHaveLength(12);
    for (const e of events) expect(validateWebhookEvent(JSON.parse(e.body))).toEqual([]);
    const first = JSON.parse(events.find((e) => e.id === eventIdFor(`${txOf(0xa000)}:1:payment.succeeded`))!.body);
    expect(first).toMatchObject({ type: "payment.succeeded", merchantId: record.publicId, livemode: false, data: { amount: "25.00", fee: "0.125", currency: "USD", mode: "now", orderId: "order-1", sessionId: null, chainId: 31337, merchant: merchant.account.address, payer: buyer.address } });

    // Signed and sent exactly as the chain sync's events are; each delivery says where its event came from.
    await dispatchDue({ limit: 100 });
    await dispatchDue({ limit: 100 });
    expect(env.deliveries).toHaveLength(12);
    for (const d of env.deliveries) verifyWebhook(d.body, d.headers["polaris-signature"], merchant.webhookSecret as string);
    signIn({ userId: merchant.userId, walletAddress: merchant.account.address });
    const log = await json(await listWebhooks(request("GET", "/api/webhooks"), params({})));
    expect(log.body.data.deliveries.every((d: { source: string }) => d.source === "indexer")).toBe(true);
    expect(log.body.data.feed).toMatchObject({ mode: "indexer" });
  });

  it("reads only rows the indexer has committed, then picks up the rest", async () => {
    await pollIndexerOutbox(); // starts after block 100, the indexer's progress
    const rows = payments(4);
    indexer.rows.push(...rows);
    indexer.progressBlock = 102; // rows 3 and 4 written but their blocks not committed
    expect(await pollIndexerOutbox()).toMatchObject({ read: 2, emitted: 2, caughtUp: true });
    indexer.progressBlock = 104;
    expect(await pollIndexerOutbox()).toMatchObject({ read: 2, emitted: 2 });
    expect(await storedEvents("indexer")).toHaveLength(4);
  });

  it("starts where the chain sync starts (POLARIS_SYNC_FROM_BLOCK), not at the indexer's head", async () => {
    setupServer({ POLARIS_INDEXER_URL: INDEXER_URL, POLARIS_SYNC_FROM_BLOCK: "103" });
    merchant = await merchantWithKeys({ webhook: true });
    record = (await getDb().merchants.get(merchant.userId)) as MerchantRecord;
    indexer = fakeIndexer();
    setOutboxClientForTests(indexer.client);
    indexer.publish(...payments(5)); // blocks 101..105
    expect(await pollIndexerOutbox()).toMatchObject({ read: 3, emitted: 3, from: (103n * STRIDE - 1n).toString() });
    expect(indexer.statusCalls).toBe(0);
  });
});

describe("a restart resumes from the stored cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "polaris-outbox-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a new process on the same SQLite file asks for the rows after the last one handled, and sends nothing twice", async () => {
    const file = join(dir, "polaris.db");
    const first = openSqliteStore(file);
    replaceStoreForTests(first);
    merchant = await merchantWithKeys({ webhook: true });
    record = (await getDb().merchants.get(merchant.userId)) as MerchantRecord;
    await pollIndexerOutbox(); // start after block 100
    const rows = payments(9);
    indexer.publish(...rows);
    expect(await pollIndexerOutbox({ pages: 1 })).toMatchObject({ read: 5, emitted: 5, caughtUp: false });

    // The restart: the store closed and reopened from disk, a fresh client.
    replaceStoreForTests(openSqliteStore(file)); // closes the first
    const again = fakeIndexer();
    again.publish(...rows);
    setOutboxClientForTests(again.client);
    expect(await pollIndexerOutbox()).toMatchObject({ read: 4, emitted: 4, duplicates: 0, caughtUp: true });
    expect(again.pages[0]?.after).toBe(rows[4]!.cursor.toString());
    expect(await storedEvents("indexer")).toHaveLength(9);

    // A crash after sending but before the cursor was saved: the rows are read again, and their ids are taken.
    await getDb().indexerOutbox.update("activity", (s) => ({ ...s, cursor: (100n * STRIDE).toString() }));
    const deliveries = (await getDb().webhookDeliveries.find({})).length;
    expect(await pollIndexerOutbox()).toMatchObject({ read: 9, emitted: 0, duplicates: 9 });
    expect(await getDb().webhookDeliveries.find({})).toHaveLength(deliveries);
    expect((await getDb().indexerOutbox.get("activity"))?.counts).toEqual({ emitted: 9, duplicates: 9, skipped: 0, rejected: 0 });
  });
});

/* ── The two sources ─────────────────────────────────────────────────────── */

/** Put logs on the fake chain as if a transaction nobody here sent (CRE, a wallet) had emitted them. */
function chainEmits(specs: LogSpec[]): Hex {
  env.chain.blockNumber += 1n;
  const txHash = `0x${env.chain.blockNumber.toString(16).padStart(64, "0")}` as Hex;
  env.chain.logs.push(...specs.map((s, i) => makeLog(s, { txHash, logIndex: i, blockNumber: env.chain.blockNumber })));
  return txHash;
}

async function openPlan(): Promise<Record<string, any>> {
  const session = await newSession(merchant);
  const deadline = BigInt(inSeconds(600));
  const intent = { buyer: buyer.address, merchant: merchant.account.address, principal: 200_000_000n, installments: 4, interval: 604_800n, orderId: session.orderId as string, nonce: 0n, deadline };
  const signature = await buyer.signTypedData({ domain: checkoutDomain, types: TYPES.PlanIntent, primaryType: "PlanIntent", message: intent });
  const res = await relayRoute(
    request("POST", "/api/relay", {
      body: { type: "openPlan", sessionId: session.id, intent: { buyer: buyer.address, principal: "200000000", installments: "4", interval: "604800", nonce: "0", deadline: String(deadline) }, signature },
    }),
    params({}),
  );
  expect(res.status).toBe(200);
  return session;
}

const engine = { address: ADDR.loanEngine, abi: polarisLoanEngineAbi as never };

describe("deduplicated against the chain sync by the event id", () => {
  it("the chain sync first: the outbox row for the same chain event is a duplicate and sends nothing", async () => {
    await syncChain();
    await pollIndexerOutbox();
    const session = await openPlan(); // the relay's receipt emits plan.opened at once
    const [opened] = await storedEvents("chain");
    expect(opened?.type).toBe("plan.opened");
    const [tx, logIndex] = opened!.sourceKey.split(":");
    const body = JSON.parse(opened!.body);
    indexer.publish(
      activity("plan.opened", {
        merchant: merchant.account.address,
        blockNumber: Number(env.chain.blockNumber),
        txHash: tx as string,
        logIndex: Number(logIndex),
        refId: "1",
        buyer: buyer.address.toLowerCase(),
        orderId: session.orderId,
        orderKey: orderKey(merchant.account.address, session.orderId),
        amount: 201_534_246n,
        principal: 200_000_000n,
        installmentCount: 4,
        interval: 604_800,
        firstDueAt: Math.floor(Date.parse(body.data.schedule[0].dueAt) / 1000),
      }),
    );
    expect(await pollIndexerOutbox()).toMatchObject({ read: 1, emitted: 0, duplicates: 1 });
    expect(await getDb().webhookEvents.find({})).toHaveLength(1);
    expect(await getDb().webhookDeliveries.find({})).toHaveLength(1);
  });

  it("the outbox first: the chain sync finds the id taken; one event, one delivery, fed by the indexer, with the chain sync's data", async () => {
    await syncChain();
    await pollIndexerOutbox();
    const session = await openPlan();
    // A CRE collection: on chain, then indexed, before this server's chain sync reads it.
    const tx = chainEmits([
      { ...engine, eventName: "InstallmentCollected", args: { loanId: 1n, caller: ADDR.collections, amount: 50_383_562n } },
      { ...engine, eventName: "InstallmentPaid", args: { loanId: 1n, borrower: buyer.address, installmentIndex: 0, amount: 50_383_562n, onTime: true } },
      { address: ADDR.collections, abi: collectionsReceiverAbi as never, eventName: "CollectionsRun", args: { tasks: 1n, executed: 1n, skipped: 0n } },
    ]);
    indexer.publish(
      activity("installment.collected", {
        merchant: merchant.account.address,
        blockNumber: Number(env.chain.blockNumber),
        txHash: tx,
        logIndex: 1,
        refId: "1",
        orderId: session.orderId,
        orderKey: orderKey(merchant.account.address, session.orderId),
        buyer: buyer.address.toLowerCase(),
        amount: 50_383_562n,
        installmentIndex: 0,
        installmentCount: 4,
        remaining: 151_150_684n,
      }),
    );
    expect(await pollIndexerOutbox()).toMatchObject({ read: 1, emitted: 1 });
    const sync = await syncChain();
    expect(sync.events).toBe(1); // the chain sync handled the log (the plan moved on) ...
    expect((await getDb().plans.get("1"))?.installmentsPaid).toBe(1);
    const collected = (await getDb().webhookEvents.find({})).filter((e) => e.type === "installment.collected");
    expect(collected).toHaveLength(1); // ... and its event was already there
    expect(collected[0]).toMatchObject({ id: eventIdFor(`${tx}:1:installment.collected:1`), source: "indexer" });
    expect(JSON.parse(collected[0]!.body).data).toEqual({
      planId: "1",
      orderId: session.orderId,
      installment: 1,
      installments: 4,
      amount: "50.383562",
      remaining: "151.150684",
      txHash: tx,
      chainId: 31337,
    });
    const deliveries = (await getDb().webhookDeliveries.find({})).filter((d) => d.type === "installment.collected");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.source).toBe("indexer");
  });

  it("in one cron tick the outbox goes first, and the chain sync's copy of the same event is dropped", async () => {
    await runTick();
    const tx = chainEmits([{ ...engine, eventName: "LoanLiquidated", args: { loanId: 1n, borrower: buyer.address, outstanding: 151_150_684n, recovered: 100_000_000n } }]);
    await openPlanRecordOnly();
    indexer.publish(
      activity("plan.liquidated", { merchant: merchant.account.address, blockNumber: Number(env.chain.blockNumber), txHash: tx, logIndex: 0, refId: "1", orderId: "ord-1", amount: 151_150_684n, recovered: 100_000_000n }),
    );
    const tick = await runTick();
    expect(tick.outbox).toMatchObject({ emitted: 1 });
    const liquidated = (await getDb().webhookEvents.find({})).filter((e) => e.type === "plan.liquidated");
    expect(liquidated).toHaveLength(1);
    expect(liquidated[0]?.source).toBe("indexer");
    expect(JSON.parse(liquidated[0]!.body).data).toMatchObject({ planId: "1", orderId: "ord-1", outstanding: "151.150684", recovered: "100.00" });
    expect((await getDb().plans.get("1"))?.state).toBe("written_off"); // the chain sync still keeps the records
  });

  it("a payout keeps the API's own id (its payout record), and one this server didn't make is not sent", async () => {
    await pollIndexerOutbox();
    const tx = txOf(0xbeef);
    await getDb().payouts.insert({
      id: "po_test1",
      merchantId: record.id,
      kind: "automatic",
      state: "submitted",
      amountUnits: "40000000",
      from: merchant.account.address,
      destination: buyer.address,
      authorizationNonce: null,
      txHash: tx as Hex,
      error: null,
      createdAt: new Date().toISOString(),
      paidAt: null,
    });
    indexer.publish(
      activity("payout.paid", { merchant: merchant.account.address, blockNumber: 101, txHash: tx, logIndex: 0, refId: `${tx}-0`, amount: 40_000_000n, destination: buyer.address.toLowerCase() }),
      activity("payout.paid", { merchant: merchant.account.address, blockNumber: 102, txHash: txOf(0xf00d), logIndex: 0, refId: "x", amount: 1_000_000n, destination: buyer.address.toLowerCase() }),
    );
    expect(await pollIndexerOutbox()).toMatchObject({ read: 2, emitted: 1, skipped: 1 });
    const [payout] = await storedEvents("indexer");
    expect(payout?.id).toBe(eventIdFor(`${tx}:payout:po_test1`));
    expect(JSON.parse(payout!.body).data).toEqual({ payoutId: "po_test1", amount: "40.00", destination: buyer.address, automatic: true, txHash: tx, chainId: 31337 });
  });
});

/** A plan the API knows about (as if it saw it open), for events that only refer to it. */
async function openPlanRecordOnly(): Promise<void> {
  const at = new Date().toISOString();
  await getDb().plans.upsert({
    id: "1",
    merchantId: record.id,
    sessionId: null,
    orderId: "ord-1",
    description: "Pay in 4",
    borrower: buyer.address,
    principalUnits: "200000000",
    totalOwedUnits: "201534246",
    repaidUnits: "50383562",
    installments: 4,
    installmentsPaid: 1,
    intervalSeconds: 604_800,
    startedAt: Number(env.chain.timestamp),
    state: "collecting",
    attempts: 0,
    lastFailure: null,
    openedTxHash: txOf(1) as Hex,
    createdAt: at,
    updatedAt: at,
  });
}

describe("what is not sent", () => {
  it("a settlement that doesn't pay its session, and a wallet that isn't a merchant here, are skipped", async () => {
    await pollIndexerOutbox();
    const session = await newSession(merchant, { amount: "200.00", modes: ["now"] });
    indexer.publish(
      activity("payment.succeeded", {
        merchant: merchant.account.address,
        blockNumber: 101,
        txHash: txOf(0xc1),
        refId: orderKey(merchant.account.address, session.orderId),
        orderKey: orderKey(merchant.account.address, session.orderId),
        orderId: session.orderId,
        buyer: buyer.address.toLowerCase(),
        amount: 1_000_000n, // $1 for a $200 checkout
        fee: 5_000n,
        mode: "PAY_NOW",
      }),
      activity("payment.succeeded", { merchant: buyer.address, blockNumber: 102, txHash: txOf(0xc2), refId: txOf(9), buyer: buyer.address.toLowerCase(), amount: 1_000_000n, fee: 0n }),
    );
    expect(await pollIndexerOutbox()).toMatchObject({ read: 2, emitted: 0, skipped: 2 });
    expect(await getDb().webhookEvents.find({})).toHaveLength(0);
  });

  it("a session's own order carries the session: its id, your order id and metadata", async () => {
    await pollIndexerOutbox();
    const session = await newSession(merchant, { metadata: { cart: "c_42" } });
    indexer.publish(
      activity("payment.succeeded", {
        merchant: merchant.account.address,
        blockNumber: 101,
        txHash: txOf(0xc3),
        refId: orderKey(merchant.account.address, session.orderId),
        orderKey: orderKey(merchant.account.address, session.orderId),
        orderId: session.orderId,
        buyer: buyer.address.toLowerCase(),
        amount: 200_000_000n,
        fee: 1_000_000n,
        mode: "PAY_NOW",
      }),
    );
    expect(await pollIndexerOutbox()).toMatchObject({ emitted: 1 });
    const [event] = await storedEvents("indexer");
    expect(JSON.parse(event!.body).data).toMatchObject({ sessionId: session.id, orderId: session.orderId, metadata: { cart: "c_42" }, amount: "200.00" });
  });
});

describe("every event is held to polarispay-sdk's validateWebhookEvent", () => {
  it("emits all nine kinds in the SDK's shape", async () => {
    await pollIndexerOutbox();
    await openPlanRecordOnly();
    await getDb().payouts.insert({ id: "po_9", merchantId: record.id, kind: "manual", state: "paid", amountUnits: "5000000", from: merchant.account.address, destination: buyer.address, authorizationNonce: null, txHash: txOf(0x99) as Hex, error: null, createdAt: new Date().toISOString(), paidAt: null });
    const m = merchant.account.address;
    const b = buyer.address.toLowerCase();
    const base = (n: number) => ({ merchant: m, blockNumber: 100 + n, txHash: txOf(0x90 + n), buyer: b, orderId: "ord-1" });
    indexer.publish(
      activity("payment.succeeded", { ...base(1), refId: txOf(0x1234), amount: 10_000_000n, fee: 50_000n, mode: "PAY_NOW" }),
      activity("plan.opened", { ...base(2), refId: "2", amount: 201_534_246n, principal: 200_000_000n, installmentCount: 4, interval: 604_800, firstDueAt: 1_790_604_800 }),
      activity("installment.collected", { ...base(3), refId: "1", amount: 50_383_562n, installmentIndex: 1, installmentCount: 4, remaining: 100_767_122n }),
      activity("installment.failed", { ...base(4), refId: "1", amount: 50_383_562n, installmentIndex: 2, installmentCount: 4, attempt: 1, nextAttemptAt: 1_790_021_600, failureReason: "insufficient_funds" }),
      activity("plan.completed", { ...base(5), refId: "1", amount: 201_534_246n }),
      activity("plan.liquidated", { ...base(6), refId: "1", amount: 100_767_122n, recovered: 0n }),
      activity("subscription.charged", { ...base(7), refId: "3", amount: 9_990_000n, fee: 49_950n, subscriptionPlanId: "7", period: 2, nextChargeAt: 1_792_592_000, mode: "SUBSCRIPTION" }),
      activity("subscription.canceled", { ...base(8), refId: "3", subscriptionPlanId: "7", canceledBy: "subscriber", amount: 9_990_000n }),
      activity("payout.paid", { ...base(9), refId: "p", amount: 5_000_000n, destination: b }),
    );
    expect(await pollIndexerOutbox()).toMatchObject({ read: 9, emitted: 9, rejected: 0 });
    const events = await storedEvents("indexer");
    expect(new Set(events.map((e) => e.type)).size).toBe(9);
    for (const e of events) expect(validateWebhookEvent(JSON.parse(e.body)), e.type).toEqual([]);
  });

  it("refuses a row whose event fails the check, or that an older indexer wrote incomplete; the cursor moves on and says so", async () => {
    await pollIndexerOutbox();
    await openPlanRecordOnly();
    const m = merchant.account.address;
    const bad = activity("installment.failed", {
      merchant: m,
      blockNumber: 101,
      txHash: txOf(0xd1),
      refId: "1",
      amount: 50_383_562n,
      installmentIndex: 1,
      attempt: 1,
      nextAttemptAt: null,
      failureReason: "the dog ate it" as never,
    });
    const incomplete = activity("plan.opened", { merchant: m, blockNumber: 102, txHash: txOf(0xd2), refId: "2", amount: 201_534_246n, installmentCount: 4, interval: 604_800, firstDueAt: 1 });
    const fine = payments(1).map((r) => ({ ...r, blockNumber: 103, cursor: 103n * STRIDE + 100n, id: (103n * STRIDE + 100n).toString() }));
    indexer.publish(bad, incomplete, ...fine);
    expect(await pollIndexerOutbox()).toMatchObject({ read: 3, emitted: 1, rejected: 2 });
    const state = await getDb().indexerOutbox.get("activity");
    expect(state?.cursor).toBe(fine[0]!.cursor.toString());
    expect(state?.lastRejected).toMatchObject({ cursor: incomplete.cursor.toString(), kind: "plan.opened" });
    expect(state?.lastRejected?.reason).toMatch(/principal/);
    expect((await storedEvents()).map((e) => e.type)).toEqual(["payment.succeeded"]);
  });
});

/* ── An indexer that doesn't answer ─────────────────────────────────────── */

describe("an unreachable indexer", () => {
  const operator = { authorization: "Bearer cron-test-secret" };

  it("records the failure, lists it on /api/health, and the chain sync carries on alone until the indexer answers again", async () => {
    await syncChain();
    await pollIndexerOutbox();
    indexer.down = true;
    const t0 = Date.now();
    const failed = await pollIndexerOutbox({ nowMs: t0 });
    expect(failed?.error).toMatch(/did not answer/);
    expect(failed?.error).toMatch(/ECONNREFUSED/);
    expect(failed?.error).not.toContain("indexer.test"); // the endpoint can carry a key; it's never repeated
    expect(await outboxHealth()).toMatchObject({ mode: "fallback", problem: expect.stringMatching(/chain sync alone/) });

    const res = await json(await health(request("GET", "/api/health", { headers: operator }), params({})));
    expect(res.body.data.webhooks).toMatchObject({ source: "fallback", indexer: { reachable: false } });
    expect(res.body.data.problems.some((p: string) => /Envio indexer .* didn't answer/.test(p))).toBe(true);
    const publicView = await json(await health(request("GET", "/api/health"), params({})));
    expect(publicView.body.data.problems).toBeUndefined();
    expect(publicView.body.data.webhooks.source).toBe("fallback");

    // Webhooks still go out: from the chain sync.
    const tx = chainEmits([{ ...engine, eventName: "LoanLiquidated", args: { loanId: 1n, borrower: buyer.address, outstanding: 1_000_000n, recovered: 0n } }]);
    await openPlanRecordOnly();
    await syncChain();
    const [liquidated] = await storedEvents("chain");
    expect(liquidated).toMatchObject({ id: eventIdFor(`${tx}:0:plan.liquidated`), source: "chain" });
    signIn({ userId: merchant.userId, walletAddress: merchant.account.address });
    const log = await json(await listWebhooks(request("GET", "/api/webhooks"), params({})));
    expect(log.body.data.feed.mode).toBe("fallback");
    expect(log.body.data.deliveries[0]).toMatchObject({ event: "plan.liquidated", source: "chain" });

    // Back up: not asked again until the back-off passes, then read from where it stopped.
    indexer.down = false;
    indexer.publish(activity("plan.liquidated", { merchant: merchant.account.address, blockNumber: Number(env.chain.blockNumber), txHash: tx, refId: "1", orderId: "ord-1", amount: 1_000_000n, recovered: 0n }));
    const pagesBefore = indexer.pages.length;
    expect(await pollIndexerOutbox({ nowMs: t0 + 1_000 })).toMatchObject({ waiting: true, read: 0 });
    expect(indexer.pages).toHaveLength(pagesBefore);
    expect(await pollIndexerOutbox({ nowMs: t0 + RETRY_AFTER_ERROR_MS + 1 })).toMatchObject({ read: 1, emitted: 0, duplicates: 1 });
    expect(await outboxHealth()).toMatchObject({ mode: "indexer", problem: null });
    const after = await json(await health(request("GET", "/api/health", { headers: operator }), params({})));
    expect(after.body.data.problems.some((p: string) => /Envio indexer/.test(p))).toBe(false);
    expect(after.body.data.webhooks).toMatchObject({ source: "indexer", indexer: { reachable: true } });
  });

  it("an indexer of another chain (no progress for this one) is a fallback too, not an empty outbox", async () => {
    await pollIndexerOutbox();
    indexer.progressBlock = null;
    expect((await pollIndexerOutbox({ force: true }))?.error).toMatch(/no progress for chain 31337/);
    expect(await outboxHealth()).toMatchObject({ mode: "fallback" });
  });

  it("through the real client: POLARIS_INDEXER_URL pointing at nothing is a fallback, not a failure of the tick", async () => {
    setOutboxClientForTests(null);
    setupServer({ POLARIS_INDEXER_URL: "http://127.0.0.1:1/v1/graphql" });
    const tick = await runTick();
    expect(tick.outbox).toMatchObject({ error: expect.stringMatching(/did not answer/) });
    expect(JSON.stringify(tick.outbox)).not.toContain("127.0.0.1:1");
    expect(await outboxHealth()).toMatchObject({ mode: "fallback", cursor: null });
    expect(tick.chain).not.toHaveProperty("error");
  });

  it("without POLARIS_INDEXER_URL nothing reads an indexer and health says the chain sync feeds webhooks", async () => {
    setOutboxClientForTests(null);
    setupServer();
    expect(await pollIndexerOutbox()).toBeNull();
    expect((await runTick()).outbox).toBe("not configured");
    const res = await json(await health(request("GET", "/api/health"), params({})));
    expect(res.body.data.webhooks).toEqual({ source: "chain-sync", indexer: null });
  });
});
