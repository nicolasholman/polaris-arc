/**
 * The client against a fake Hasura: what it sends, how it reads the answer,
 * and how it fails.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIndexerClient, IndexerError, type FetchLike } from "../src/index.js";

type Sent = { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } };

function fakeHasura(answer: (sent: Sent) => unknown, status = 200) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const s = { url, headers: init.headers, body: JSON.parse(init.body) };
    sent.push(s);
    const json = answer(s);
    return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { fetch, sent };
}

const URL = "http://localhost:8080/v1/graphql";
const MERCHANT = "0xAbC0000000000000000000000000000000000001";

describe("indexer client", () => {
  it("lowercases addresses, sends bigints as numeric strings and parses BigInt columns", async () => {
    const hasura = fakeHasura((s) => {
      if (s.body.query.includes("query ActivityAfter")) {
        return {
          data: {
            Activity: [
              { id: "1", cursor: "12000000010", kind: "payment.succeeded", merchant_id: MERCHANT.toLowerCase(), amount: "25000000", fee: "125000", blockNumber: 1200, logIndex: 1, refId: "0xab", timestamp: 1, txHash: "0x1" },
              { id: "2", cursor: "13000000000", kind: "payout.paid", merchant_id: MERCHANT.toLowerCase(), amount: 5, fee: null, blockNumber: 1300, logIndex: 0, refId: "0xcd", timestamp: 2, txHash: "0x2" },
            ],
            _meta: [{ chainId: 10143, progressBlock: 1250, isReady: true }],
          },
        };
      }
      return { data: { Merchant: [{ id: MERCHANT.toLowerCase(), balance: "336805050", grossVolume: "1", mrr: 0, maxOrderValue: null }], recentPayments: [], days: [] } };
    });
    const client = createIndexerClient({ url: URL, fetch: hasura.fetch, headers: { "x-hasura-admin-secret": "testing" }, now: () => 86_400_000 * 20_000 });

    const overview = await client.merchantOverview(MERCHANT, { days: 7 });
    assert.equal(hasura.sent[0]!.body.variables.merchant, MERCHANT.toLowerCase());
    assert.equal(hasura.sent[0]!.body.variables.fromDay, 20_000 - 6);
    assert.equal(hasura.sent[0]!.headers["x-hasura-admin-secret"], "testing");
    assert.equal(overview.merchant?.balance, 336_805_050n);
    assert.equal(overview.merchant?.mrr, 0n);
    assert.equal(overview.merchant?.maxOrderValue, null);

    const page = await client.activityAfter(11_000_000_000n);
    assert.equal(hasura.sent[1]!.body.variables.after, "11000000000");
    // Block 1300 is past the indexer's progress block: not committed yet, not returned.
    assert.equal(page.activities.length, 1);
    assert.equal(page.activities[0]!.cursor, 12_000_000_010n);
    assert.equal(page.activities[0]!.fee, 125_000n);
    assert.equal(page.progressBlock, 1250);
  });

  it("maps the dashboard's plan tabs to filters", async () => {
    const hasura = fakeHasura(() => ({ data: { Plan: [] } }));
    const client = createIndexerClient({ url: URL, fetch: hasura.fetch });
    await client.plans(MERCHANT, { filter: "dunning" });
    await client.plans(MERCHANT, { filter: "closed", limit: 10, offset: 20 });
    assert.deepEqual(hasura.sent[0]!.body.variables.where, { merchant_id: { _eq: MERCHANT.toLowerCase() }, status: { _eq: "ACTIVE" }, dunning: { _eq: true } });
    assert.deepEqual(hasura.sent[1]!.body.variables, { where: { merchant_id: { _eq: MERCHANT.toLowerCase() }, status: { _in: ["REPAID", "LIQUIDATED"] } }, limit: 10, offset: 20 });
  });

  it("decodes nested instalments", async () => {
    const hasura = fakeHasura(() => ({
      data: {
        Plan: [{ id: "1", loanId: "1", principal: "200000000", totalOwed: "201534246", installments: [{ id: "1-0", index: 0, amount: "50383562", paid: "0" }], repayments: [{ id: "r", amount: "50383562" }] }],
        CollectionTask: [{ id: "t", targetId: "1", amount: null, have: "0", need: "50383562" }],
      },
    }));
    const client = createIndexerClient({ url: URL, fetch: hasura.fetch });
    const detail = await client.plan(1n);
    assert.equal(hasura.sent[0]!.body.variables.loanIdNumeric, "1");
    assert.equal(detail?.plan.installments[0]!.amount, 50_383_562n);
    assert.equal(detail?.repayments[0]!.amount, 50_383_562n);
    assert.equal(detail?.collections[0]!.need, 50_383_562n);
  });

  it("waits for an order to be paid in the index, and gives up on time", async () => {
    let calls = 0;
    const hasura = fakeHasura(() => {
      calls += 1;
      return { data: { Order: calls < 3 ? [] : [{ id: "0xab", status: "PAID", amount: "25000000", quotedAmount: null }] } };
    });
    const client = createIndexerClient({ url: URL, fetch: hasura.fetch });
    const order = await client.waitForOrder("0xAB", { intervalMs: 1, timeoutMs: 1_000 });
    assert.equal(order?.status, "PAID");
    assert.equal(order?.amount, 25_000_000n);
    assert.equal(hasura.sent[0]!.body.variables.orderKey, "0xab");

    const never = createIndexerClient({ url: URL, fetch: fakeHasura(() => ({ data: { Order: [] } })).fetch });
    assert.equal(await never.waitForOrder("0xab", { intervalMs: 5, timeoutMs: 20 }), null);
  });

  it("builds CRE tasks from the candidate query", async () => {
    const hasura = fakeHasura(() => ({
      data: {
        Loan: [
          { loanId: "9", liquidatableAt: 1_789_999_000 },
          { loanId: "3", liquidatableAt: 1_790_003_601 },
          { loanId: "2", liquidatableAt: 1_790_003_601 },
        ],
        Subscription: [{ subId: "4" }],
      },
    }));
    const client = createIndexerClient({ url: URL, fetch: hasura.fetch });
    const tasks = await client.dueCandidates(1_790_000_000, 25);
    assert.deepEqual(hasura.sent[0]!.body.variables, { now: 1_790_000_000, limit: 25 });
    assert.deepEqual(tasks, [
      { action: 3, id: 9n },
      { action: 1, id: 2n },
      { action: 1, id: 3n },
      { action: 2, id: 4n },
    ]);
  });

  it("surfaces GraphQL errors, HTTP errors and a dead endpoint", async () => {
    const withErrors = createIndexerClient({ url: URL, fetch: fakeHasura(() => ({ errors: [{ message: "field 'Nope' not found in type: 'query_root'" }] })).fetch });
    await assert.rejects(withErrors.status(), (e: unknown) => e instanceof IndexerError && /Nope/.test(e.message) && e.errors.length === 1);

    const down = createIndexerClient({ url: URL, fetch: fakeHasura(() => ({}), 503).fetch });
    await assert.rejects(down.status(), (e: unknown) => e instanceof IndexerError && e.status === 503);

    const dead = createIndexerClient({
      url: URL,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await assert.rejects(dead.status(), (e: unknown) => e instanceof IndexerError && /did not answer/.test(e.message));

    assert.throws(() => createIndexerClient({ url: "localhost:8080", fetch: fakeHasura(() => ({})).fetch }), /http/);
  });

  it("reads Envio's _meta for the configured chain", async () => {
    const client = createIndexerClient({
      url: URL,
      chainId: 10143,
      fetch: fakeHasura(() => ({ data: { _meta: [{ chainId: 1, progressBlock: 5, isReady: false }, { chainId: 10143, progressBlock: 66_000_000, sourceBlock: 66_000_002, isReady: true, readyAt: "2026-10-05T00:00:00Z" }] } })).fetch,
    });
    assert.deepEqual(await client.status(), {
      chainId: 10143,
      progressBlock: 66_000_000,
      sourceBlock: 66_000_002,
      eventsProcessed: null,
      isReady: true,
      readyAt: "2026-10-05T00:00:00Z",
      startBlock: null,
    });
  });
});
