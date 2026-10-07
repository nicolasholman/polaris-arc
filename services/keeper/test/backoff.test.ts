import assert from "node:assert/strict";
import { test } from "node:test";

import { instalmentDueAt, loanVerdict, nextRung, onRung, subscriptionVerdict, SUBSCRIPTION_CHARGE_WINDOW_SECONDS } from "../src/backoff.ts";

const b = { ladderSeconds: [3_600, 86_400], windowSeconds: 600 };

test("a task is tried when it falls due, then once per rung of the ladder", () => {
  const due = 1_000_000;
  assert.equal(onRung(due - 1, due, b), false);
  assert.equal(onRung(due, due, b), true);
  assert.equal(onRung(due + 599, due, b), true);
  assert.equal(onRung(due + 600, due, b), false);
  assert.equal(onRung(due + 3_600, due, b), true);
  assert.equal(nextRung(due + 700, due, b), due + 3_600);
  assert.equal(onRung(due + 3_600 + 86_400 + 10, due, b), true);
});

test("past grace a plan is always tried; past its window a subscription is too", () => {
  assert.deepEqual(loanVerdict(5_000, 1_000, true, b), { attempt: true, why: "past-grace" });
  const v = loanVerdict(1_000 + 700, 1_000, false, b);
  assert.equal(v.attempt, false);
  assert.deepEqual(subscriptionVerdict(1_000 + SUBSCRIPTION_CHARGE_WINDOW_SECONDS + 1, 1_000, b), { attempt: true, why: "past-charge-window" });
});

test("the next instalment falls due one interval after the last one paid", () => {
  assert.equal(instalmentDueAt({ startedAt: 100n, intervalSeconds: 60n, installmentsPaid: 0 }), 160);
  assert.equal(instalmentDueAt({ startedAt: 100n, intervalSeconds: 60n, installmentsPaid: 2 }), 280);
});
