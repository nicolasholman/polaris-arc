import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { collections } from "../src/schema.ts";
import { DuplicateKeyError, openMemoryStore, openSqliteStore, openStore, type CollectionSpec, type Store } from "../src/store/index.ts";

type Doc = { id: string; merchant: string; amount: number; at: string; paid: boolean; note: string | null };

const spec: CollectionSpec<Doc> = {
  name: "docs",
  id: (d) => d.id,
  indexes: {
    merchant: (d) => d.merchant,
    amount: (d) => d.amount,
    at: (d) => d.at,
    paid: (d) => d.paid,
    note: (d) => d.note,
    // camelCase index names, as the record schema uses (publicId, nextAttemptAtMs, ...)
    merchantUpper: (d) => d.merchant.toUpperCase(),
  },
};

const dir = mkdtempSync(join(tmpdir(), "polaris-db-"));
const opened: Store[] = [];
afterAll(() => {
  // Windows keeps an open database file locked: close every store first.
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const track = (s: Store) => (opened.push(s), s);

const stores: Array<[string, () => Store]> = [
  ["memory", () => openMemoryStore()],
  ["sqlite", () => track(openSqliteStore(join(dir, `t-${Math.random().toString(36).slice(2)}.db`)))],
];

const doc = (id: string, over: Partial<Doc> = {}): Doc => ({
  id,
  merchant: "m1",
  amount: 100,
  at: `2026-10-0${id.slice(-1)}T00:00:00.000Z`,
  paid: false,
  note: null,
  ...over,
});

describe.each(stores)("%s store", (_name, open) => {
  it("inserts, reads, refuses a duplicate id, upserts and deletes", async () => {
    const c = open().collection(spec);
    await c.insert(doc("a1"));
    expect(await c.get("a1")).toEqual(doc("a1"));
    await expect(c.insert(doc("a1"))).rejects.toBeInstanceOf(DuplicateKeyError);
    await c.upsert(doc("a1", { amount: 5 }));
    expect((await c.get("a1"))?.amount).toBe(5);
    expect(await c.delete("a1")).toBe(true);
    expect(await c.delete("a1")).toBe(false);
    expect(await c.get("a1")).toBeNull();
  });

  it("updates atomically and keeps indexes in step", async () => {
    const c = open().collection(spec);
    await c.insert(doc("a1"));
    const next = await c.update("a1", (d) => ({ ...d, paid: true, merchant: "m2" }));
    expect(next?.paid).toBe(true);
    expect(await c.find({ merchant: "m2" })).toHaveLength(1);
    expect(await c.find({ merchant: "m1" })).toHaveLength(0);
    expect(await c.find({ paid: true })).toHaveLength(1);
    expect(await c.update("missing", (d) => d)).toBeNull();
    await expect(c.update("a1", (d) => ({ ...d, id: "other" }))).rejects.toThrow(/must not change the id/);
  });

  it("filters by equality, ranges, sets and NULL, and orders", async () => {
    const c = open().collection(spec);
    for (const [i, amount] of [10, 20, 30, 40].entries()) {
      await c.insert(doc(`d${i + 1}`, { amount, merchant: i % 2 ? "m2" : "m1", note: i === 3 ? "x" : null }));
    }
    expect((await c.find({ amount: { gte: 20, lt: 40 } })).map((d) => d.id)).toEqual(["d2", "d3"]);
    expect((await c.find({ merchant: { in: ["m2"] } })).map((d) => d.id)).toEqual(["d2", "d4"]);
    expect((await c.find({ note: null })).map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect((await c.find({ note: { ne: null } })).map((d) => d.id)).toEqual(["d4"]);
    expect((await c.find({}, { orderBy: "at", direction: "desc", limit: 2 })).map((d) => d.id)).toEqual(["d4", "d3"]);
    expect((await c.find({}, { orderBy: "amount", offset: 1, limit: 2 })).map((d) => d.id)).toEqual(["d2", "d3"]);
    expect(await c.count({ merchant: "m1" })).toBe(2);
    expect((await c.findOne({ merchant: "m2" }, { orderBy: "amount", direction: "desc" }))?.id).toBe("d4");
    expect(await c.find({ merchant: { in: [] } })).toEqual([]);
  });

  it("queries a camelCase index", async () => {
    const c = open().collection(spec);
    await c.insert(doc("c1", { merchant: "m9" }));
    expect((await c.find({ merchantUpper: "M9" })).map((d) => d.id)).toEqual(["c1"]);
  });

  it("opens every collection of the record schema", () => {
    const store = open();
    expect(() => collections(store)).not.toThrow();
  });

  it("finds a buyer's sealed receipts by owner and transaction, whatever the case they were written in", async () => {
    const db = collections(open());
    const base = { kind: "payment" as const, enc: "ZW5j", ct: "Y3Q", amountUnits: "1", merchantId: "m", createdAt: "2026-10-01T00:00:00.000Z" };
    await db.receipts.insert({ ...base, id: "0xa", owner: "0xAbC0000000000000000000000000000000000001", txHash: "0xFF01" });
    await db.receipts.insert({ ...base, id: "0xb", owner: "0xdef0000000000000000000000000000000000002", txHash: null });
    expect((await db.receipts.find({ owner: "0xabc0000000000000000000000000000000000001" })).map((r) => r.id)).toEqual(["0xa"]);
    expect((await db.receipts.find({ txHash: "0xff01" })).map((r) => r.id)).toEqual(["0xa"]);
    await db.receiptInboxes.upsert({ id: "0xabc0000000000000000000000000000000000001", publicKey: `0x${"11".repeat(32)}`, signature: "0x00", registeredAt: base.createdAt, updatedAt: base.createdAt });
    expect(await db.receiptInboxes.get("0xabc0000000000000000000000000000000000001")).toMatchObject({ publicKey: `0x${"11".repeat(32)}` });
  });

  it("refuses queries on fields that aren't indexed", async () => {
    const c = open().collection(spec);
    await expect(c.find({ nope: 1 })).rejects.toThrow(/not an indexed field/);
  });
});

describe("sqlite persistence", () => {
  it("keeps documents across reopen and back-fills a new index", async () => {
    const path = join(dir, "persist.db");
    const first = openSqliteStore(path);
    await first.collection(spec).insert(doc("p1", { amount: 7 }));
    first.close();

    const widened: CollectionSpec<Doc & { extra?: string }> = {
      ...(spec as CollectionSpec<Doc & { extra?: string }>),
      indexes: { ...spec.indexes, doubled: (d) => d.amount * 2 },
    };
    const second = openSqliteStore(path);
    const c = second.collection(widened);
    expect((await c.find({ doubled: 14 })).map((d) => d.id)).toEqual(["p1"]);
    second.close();
  });

  it("keeps the indexer outbox's cursor across a restart, exactly, past 2^53", async () => {
    const path = join(dir, "outbox.db");
    const cursor = (2n ** 60n + 4_00n).toString(); // a decimal string: a Number would round it
    const at = "2026-10-07T00:00:00.000Z";
    const first = openSqliteStore(path);
    await collections(first).indexerOutbox.upsert({
      id: "activity",
      cursor,
      progressBlock: 90,
      polledAt: at,
      okAt: at,
      error: null,
      errorAt: null,
      counts: { emitted: 3, duplicates: 1, skipped: 0, rejected: 0 },
      lastRejected: null,
      updatedAt: at,
    });
    first.close();
    const second = openSqliteStore(path);
    expect(await collections(second).indexerOutbox.get("activity")).toMatchObject({ cursor, progressBlock: 90, counts: { emitted: 3, duplicates: 1 } });
    second.close();
  });

  it("opens by URL", () => {
    expect(openStore("memory:").kind).toBe("memory");
    const s = openStore(`sqlite:${join(dir, "url.db")}`);
    expect(s.kind).toBe("sqlite");
    s.close();
    expect(() => openStore("postgres://x")).toThrow(/Unrecognised/);
  });
});
