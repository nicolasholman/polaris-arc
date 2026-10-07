import type { Activity, IndexerClient } from "@polarispay/indexer-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCollectionsRun, getIndexedEvents, getUnderwritingReasons } from "@/lib/data/insights";
import type { Payment, Plan } from "@/lib/data/types";
import { getDb } from "@/server/db";
import { merchantInsights, setIndexerClientForTests } from "@/server/insights";

import { setupServer } from "./helpers/env";

/**
 * The Overview's Envio and credit panels for a live merchant: the Envio
 * indexer's events through @polarispay/indexer-client when it is configured,
 * this server's chain sync (labelled) when it isn't, and the reasons the CRE
 * underwriting decisions carried for the merchant's Pay in 4 buyers.
 */

const WALLET = "0x2222222222222222222222222222222222222222";
const BUYER = "0x5555555555555555555555555555555555555555";
const TX = `0x${"ab".repeat(32)}` as const;

const payment: Payment = {
  id: "pay_1",
  orderId: "hc_1",
  description: "Oak lounge chair",
  buyer: BUYER,
  mode: "later",
  status: "succeeded",
  amountCents: 200_00,
  feeCents: 0,
  netCents: 200_00,
  linkId: null,
  txHash: TX,
  createdAt: "2026-09-28T10:00:00.000Z",
};

const plan = {
  id: "7",
  orderId: "hc_1",
  description: "Oak lounge chair",
  buyer: BUYER,
  principalCents: 200_00,
  totalCents: 201_53,
  installmentCount: 4,
  installmentsPaid: 0,
  state: "collecting",
  openedAt: "2026-09-28T10:00:00.000Z",
} as unknown as Plan;

const activity: Activity = {
  id: "0xabc-1",
  cursor: 1n,
  kind: "plan.opened",
  merchant_id: WALLET,
  buyer: BUYER,
  orderId: "hc_1",
  orderKey: null,
  mode: "LATER" as Activity["mode"],
  amount: 200_000_000n,
  fee: null,
  refId: "7",
  installmentIndex: null,
  installmentCount: 4,
  principal: 200_000_000n,
  interval: 604_800,
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
  blockNumber: 1234,
  logIndex: 3,
  txHash: TX,
};

beforeEach(() => {
  setupServer();
});
afterEach(() => setIndexerClientForTests(null));

describe("the Envio panel", () => {
  it("reads the merchant's events from the Envio indexer when it is configured", async () => {
    const asked: string[] = [];
    setIndexerClientForTests({
      merchantActivity: async (merchant: string) => {
        asked.push(merchant);
        return [activity];
      },
      status: async () => ({ progressBlock: 1300 }),
    } as unknown as IndexerClient);
    const insights = await merchantInsights({ wallet: WALLET, payments: [payment], plans: [plan] });
    expect(asked).toEqual([WALLET]);
    expect(insights?.indexer).toMatchObject({ source: "envio", progressBlock: 1300 });
    const feed = getIndexedEvents({ insights });
    expect(feed.source).toBe("live");
    if (feed.source !== "live") return;
    expect(feed.via).toBeUndefined();
    expect(feed.data[0]).toMatchObject({ type: "plan.opened", amountCents: 200_00, block: 1234, txHash: TX, title: "Order hc_1, Pay in 4" });
  });

  it("says so when the indexer doesn't answer", async () => {
    setIndexerClientForTests({
      merchantActivity: async () => {
        throw new Error("indexer down");
      },
      status: async () => null,
    } as unknown as IndexerClient);
    const insights = await merchantInsights({ wallet: WALLET, payments: [payment], plans: [plan] });
    const feed = getIndexedEvents({ insights });
    // A fixed sentence on the dashboard; the error itself goes to the server log.
    expect(feed).toMatchObject({ source: "not_connected", reason: expect.stringContaining("The indexer didn't answer") });
    expect(JSON.stringify(feed)).not.toContain("indexer down");
  });

  it("falls back to the chain sync's events, labelled, without an indexer", async () => {
    const insights = await merchantInsights({ wallet: WALLET, payments: [payment], plans: [plan] });
    const feed = getIndexedEvents({ insights });
    expect(feed).toMatchObject({ source: "live", via: "chain-sync" });
  });

  it("says the indexer isn't configured when the Overview has no insights, and invents nothing", () => {
    const feed = getIndexedEvents({});
    expect(feed).toMatchObject({ source: "not_connected", reason: expect.stringContaining("POLARIS_INDEXER_URL") });
    expect(getUnderwritingReasons({}).source).toBe("not_connected");
  });
});

describe("why buyers got credit", () => {
  it("shows the reasons the CRE decisions carried, with their providers", async () => {
    await getDb().creditDecisions.upsert({
      id: BUYER.toLowerCase(),
      status: "applied",
      score: 612,
      reason: null,
      linkedWallet: "0x6666666666666666666666666666666666666666",
      txHash: TX,
      callbackId: "cb_1",
      at: new Date().toISOString(),
      explanation: {
        score: 612,
        limitUnits: "500000000",
        source: "package",
        reasons: [
          { text: "First funded from Coinbase · +10", points: 10, kind: "exchange", provider: "nansen" },
          { text: "Wallet first used 3 years ago", points: 60, kind: "age", provider: "zerion" },
          { text: "No history of liquidations", points: 0, kind: "liquidations", provider: null },
          { text: "You keep $4,851 on hand across your accounts · +48", points: 48, kind: "plus", provider: "rpc" },
        ],
      },
    });
    const insights = await merchantInsights({ wallet: WALLET, payments: [payment], plans: [plan] });
    const reasons = getUnderwritingReasons({ insights });
    expect(reasons.source).toBe("live");
    if (reasons.source !== "live") return;
    expect(reasons.data.buyers).toBe(1);
    expect(reasons.data.averageLineCents).toBe(500_00);
    expect(reasons.data.reasons).toEqual([
      { text: "Wallet first used 3 years ago", points: 60, source: "Zerion" },
      // The buyer's own words are told to the merchant in the third person.
      { text: "Buyer keeps $4,851 across their accounts", points: 48, source: null },
      { text: "First funded from Coinbase", points: 10, source: "Nansen" },
    ]);
  });

  it("says nothing has reported until a decision exists", async () => {
    const insights = await merchantInsights({ wallet: WALLET, payments: [payment], plans: [plan] });
    expect(insights?.underwriting).toBeNull();
    expect(getUnderwritingReasons({ insights }).source).toBe("not_connected");
  });
});

describe("the collections panel", () => {
  it("says no run has reported until the workflow's heartbeat arrives", () => {
    const run = getCollectionsRun({ plans: [plan], collector: { state: "stopped", lastPassAt: null, runner: "cre" } });
    expect(run).toMatchObject({ source: "not_connected", reason: expect.stringContaining("Chainlink CRE") });
    expect(getCollectionsRun({ plans: [plan] }).source).toBe("not_connected");
  });

  it("shows the workflow's last real report, and nothing it didn't report", () => {
    const at = "2026-10-01T10:00:04.000Z";
    const run = getCollectionsRun({ plans: [plan], collector: { state: "running", lastPassAt: at, runner: "cre" } });
    expect(run.source).toBe("live");
    if (run.source !== "live") return;
    expect(run.data.lastRun).toMatchObject({ at, checked: 1, collected: null, collectedCents: null });
    expect(run.data.nextRunAt).toBe("2026-10-01T10:01:04.000Z");
    expect(run.data.history).toEqual([]);
  });
});
