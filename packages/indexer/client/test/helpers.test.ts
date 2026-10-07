/**
 * The pure helpers: CRE task building, money, and the credit line and loan
 * ladder mirrors (kept equal to the indexer's own copies). Webhook events are
 * in webhooks.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { creditLimitOf as indexerCreditLimit } from "../../src/lib/credit.js";
import { installmentSlice as indexerSlice, thresholdFor as indexerThreshold } from "../../src/lib/loans.js";
import {
  creditLimitOf,
  dueCandidatesRequest,
  formatAmount,
  formatUsd,
  fromCents,
  installmentSlice,
  parseDueCandidates,
  readyTasks,
  thresholdFor,
  toCents,
} from "../src/index.js";

describe("CRE candidates", () => {
  it("validates its inputs", () => {
    assert.throws(() => dueCandidatesRequest(0));
    assert.throws(() => dueCandidatesRequest(1_790_000_000, 0));
    assert.deepEqual(dueCandidatesRequest(1_790_000_000, 10).variables, { now: 1_790_000_000, limit: 10 });
  });

  const NOW = 1_790_000_000;
  const due = (loanId: string | number, liquidatableAt: number | null = NOW + 3_601) => ({ loanId, liquidatableAt });

  it("builds the same ordered, deduplicated list whatever order the rows come in", () => {
    const a = parseDueCandidates({ data: { Loan: [due("5"), due("2", NOW - 1), due("5")], Subscription: [{ subId: 7 }, { subId: 1 }] } }, NOW);
    const b = parseDueCandidates({ Loan: [due(2, NOW), due(5)], Subscription: [{ subId: "1" }, { subId: "7" }] }, NOW);
    assert.deepEqual(a, b);
    // Loan 2 is past grace: liquidated, not collected.
    assert.deepEqual(a, [
      { action: 3, id: 2n },
      { action: 1, id: 5n },
      { action: 2, id: 1n },
      { action: 2, id: 7n },
    ]);
  });

  it("caps the list at what one checkTasks read can carry, and keeps only ready tasks", () => {
    const many = { Loan: Array.from({ length: 400 }, (_, i) => due(i + 1)) };
    assert.equal(parseDueCandidates(many, NOW).length, 72);
    const tasks = parseDueCandidates({ Loan: [due(1), due(2)] }, NOW);
    assert.deepEqual(readyTasks(tasks, [false, true]), [{ action: 1, id: 2n }]);
    assert.throws(() => readyTasks(tasks, [true]));
  });

  it("refuses an answer with errors", () => {
    assert.throws(() => parseDueCandidates({ errors: [{ message: "boom" }] }, NOW), /boom/);
  });
});

describe("money", () => {
  it("converts base units to cents without floats", () => {
    assert.equal(toCents(50_383_562n), 5038);
    assert.equal(toCents(125_000n), 13); // half a cent rounds up
    assert.equal(toCents(-125_000n), -13);
    assert.equal(fromCents(5038), 50_380_000n);
    assert.equal(formatUsd(1_234_567_890n), "$1,234.57");
    assert.equal(formatUsd(0n), "$0.00");
  });

  it("writes amounts as webhooks carry them: dollars with 2 to 6 decimals", () => {
    assert.equal(formatAmount(25_000_000n), "25.00");
    assert.equal(formatAmount(201_534_246n), "201.534246");
    assert.equal(formatAmount(1_000_050n), "1.00005");
    assert.equal(formatAmount(125_000n), "0.125");
    assert.equal(formatAmount(1n), "0.000001");
    assert.equal(formatAmount(0n), "0.00");
    assert.equal(formatAmount(-2_500_000n), "-2.50");
  });
});

describe("loan ladder", () => {
  it("matches the indexer's PolarisLoanEngine mirror everywhere", () => {
    for (const owed of [1n, 3n, 100_000_076n, 201_534_246n, 5_000_000_001n]) {
      for (const n of [1, 2, 3, 4, 6, 12, 24]) {
        let sum = 0n;
        for (let k = -1; k <= n + 1; k++) assert.equal(thresholdFor(owed, n, k), indexerThreshold(owed, n, k));
        for (let i = 0; i < n; i++) {
          assert.equal(installmentSlice(owed, n, i), indexerSlice(owed, n, i));
          sum += installmentSlice(owed, n, i);
        }
        assert.equal(sum, owed);
      }
    }
  });
});

describe("credit line", () => {
  it("matches the indexer's ScoreManager mirror everywhere", () => {
    for (const score of [300, 579, 580, 669, 670, 739, 740, 799, 800, 850]) {
      for (const flags of [0, 1, 2, 3, 4, 5, 6, 7]) {
        for (const collateral of [0n, 100_000_000n]) {
          const b = { score, hasRecord: Boolean(flags & 1), declined: Boolean(flags & 2), underwritten: Boolean(flags & 4), collateral };
          for (const s of [
            { requireUnderwriting: true, collateralCountsTowardLimits: true, collateralMultiplierBps: 15_000 },
            { requireUnderwriting: false, collateralCountsTowardLimits: false, collateralMultiplierBps: 30_000 },
          ]) {
            assert.equal(creditLimitOf(b, s), indexerCreditLimit(b, s), JSON.stringify({ ...b, collateral: String(collateral), ...s }));
          }
        }
      }
    }
  });
});
