import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { chainWindow, decodeCollectionsReport, encodeCollectionsReport, planTasks, ACTION } from "../src/tasks.ts";

const require = createRequire(import.meta.url);
const lib = require("@polarispay/contracts/lib/keeper") as { encodeCollectionsReport: (t: { action: number; id: bigint }[]) => string };

test("the collections report is byte for byte the contracts' own encoding", () => {
  const tasks = [
    { action: ACTION.COLLECT_INSTALLMENT, id: 7n },
    { action: ACTION.CHARGE_SUBSCRIPTION, id: 2n },
    { action: ACTION.LIQUIDATE, id: 2n ** 200n },
  ];
  assert.equal(encodeCollectionsReport(tasks), lib.encodeCollectionsReport(tasks));
  assert.deepEqual(decodeCollectionsReport(encodeCollectionsReport(tasks)), { kind: 1, tasks });
  assert.equal(encodeCollectionsReport([]), lib.encodeCollectionsReport([]));
});

test("the chain window takes the newest ids and rotates through the older ones", () => {
  assert.deepEqual(chainWindow(0n, 5, 5, 1n), []);
  assert.deepEqual(chainWindow(3n, 5, 5, 1n), [1n, 2n, 3n]);
  const w = chainWindow(100n, 10, 5, 1n);
  assert.equal(w.length, 15);
  for (let id = 91n; id <= 100n; id++) assert.ok(w.includes(id));
  const seen = new Set<string>();
  for (let t = 0n; t < 200n; t++) for (const id of chainWindow(100n, 10, 5, t)) seen.add(String(id));
  assert.equal(seen.size, 100, "every id is revisited");
});

test("a plan collects before it liquidates, loans before charges, and stops at the cap", () => {
  const tasks = planTasks({ collect: [3n, 1n], liquidate: [3n], charge: [9n, 8n] }, 10);
  assert.deepEqual(tasks, [
    { action: 1, id: 1n },
    { action: 1, id: 3n },
    { action: 3, id: 3n },
    { action: 2, id: 8n },
    { action: 2, id: 9n },
  ]);
  assert.equal(planTasks({ collect: [1n, 2n, 3n], liquidate: [], charge: [4n] }, 2).length, 2);
});
