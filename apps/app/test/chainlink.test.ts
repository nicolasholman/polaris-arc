import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { duePayment, owedOnOpenPlans, plansNeedingSignature, signAgainState } from "../src/lib/collection.ts";
import { GUARD_PAUSED_MESSAGE, laterPausedMessage, staleGuardLine, toGuardView } from "../src/lib/credit-guard.ts";
import type { CreditGuardView, PaymentLink, Plan } from "../src/lib/data/types.ts";
import { provenanceOf } from "../src/lib/provenance.ts";

/**
 * The Chainlink states the app shows: the risk guard (paused, or late and
 * failing open) and a plan's collection after a lost approval (sign again,
 * collecting, collected). Pure functions over what Polaris for Business
 * serves; the screens only lay them out.
 */

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

function plan(over: Partial<Plan> = {}): Plan {
  const due = (i: number) => NOW - 86_400_000 + i * 604_800_000;
  return {
    id: "7",
    loanId: 7n,
    merchant: { id: "m", name: "Halcyon", address: "0x0000000000000000000000000000000000000001", city: "", country: "", category: "" },
    description: "Pay in 4",
    principal: 200_000_000n,
    interest: 1_534_246n,
    interval: 604_800,
    instalments: [0, 1, 2, 3].map((i) => ({ index: i, amount: 50_383_562n, dueAt: due(i), paidAt: null })),
    status: "active",
    openedAt: NOW - 8 * 86_400_000,
    ...over,
  };
}

const TX = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const TX2 = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

describe("a plan after a lost approval", () => {
  it("asks to sign again, then shows collecting, then collected (for a day)", () => {
    const failure = { reason: "allowance_lost" as const, at: NOW - 60_000, nextAttemptAt: NOW + 6 * 3_600_000 };
    const needed = plan({ collection: { failure, needsSignature: true, reauthorized: null } });
    assert.equal(signAgainState(needed, NOW), "needed");
    assert.deepEqual(plansNeedingSignature([needed, plan()]).map((p) => p.id), ["7"]);

    const collecting = plan({ collection: { failure, needsSignature: false, reauthorized: { at: NOW, txHash: TX, collected: null } } });
    assert.equal(signAgainState(collecting, NOW), "collecting");
    assert.deepEqual(plansNeedingSignature([collecting]), []);

    const collected = plan({ collection: { failure: null, needsSignature: false, reauthorized: { at: NOW, txHash: TX, collected: { at: NOW + 7_000, txHash: TX2 } } } });
    assert.equal(signAgainState(collected, NOW + 10_000), "collected");
    assert.equal(signAgainState(collected, NOW + 7_000 + 86_400_000), null);

    // The offline demo's plans carry no collection state; a failure for money, not approval, never asks to sign.
    assert.equal(signAgainState(plan(), NOW), null);
    assert.equal(signAgainState(plan({ collection: { failure: { ...failure, reason: "insufficient_funds" }, needsSignature: false, reauthorized: null } }), NOW), null);
  });

  it("names the payment that failed, and a permit covering every open plan", () => {
    const one = plan({ instalments: plan().instalments.map((i) => (i.index === 0 ? { ...i, paidAt: NOW - 1 } : i)) });
    assert.equal(duePayment(one)?.index, 1);
    assert.equal(owedOnOpenPlans([one, plan({ id: "8" }), plan({ id: "9", status: "completed" })]), 3n * 50_383_562n + 4n * 50_383_562n);
  });
});

describe("the risk guard", () => {
  const view = (over: Partial<CreditGuardView>): CreditGuardView => ({ state: "open", paused: false, message: null, ageSeconds: 120, readAt: NOW, ...over });

  it("takes the API's guard, with the buyer's words while paused", () => {
    const paused = toGuardView({ state: "paused", paused: true, message: null, ageSeconds: 30, readAt: new Date(NOW).toISOString() });
    assert.deepEqual(paused, { state: "paused", paused: true, message: GUARD_PAUSED_MESSAGE, ageSeconds: 30, readAt: NOW });
    assert.equal(GUARD_PAUSED_MESSAGE, "Pay in 4 is paused by our risk guard; pay now works as usual.");
    assert.equal(toGuardView({ state: "open", paused: false, message: "ignored", ageSeconds: 30, readAt: new Date(NOW).toISOString() }).message, null);
  });

  it("says when a late guard last checked, counting from when it was read", () => {
    assert.equal(staleGuardLine(view({ state: "stale", ageSeconds: 4320 }), NOW), "Risk guard last checked 72 min ago");
    assert.equal(staleGuardLine(view({ state: "stale", ageSeconds: 3000 }), NOW + 600_000), "Risk guard last checked 60 min ago");
    assert.equal(staleGuardLine(view({ state: "stale", ageSeconds: 3 * 3600 }), NOW), "Risk guard last checked 3 h ago");
    assert.equal(staleGuardLine(view({ state: "open" }), NOW), null);
    assert.equal(staleGuardLine(null, NOW), null);
  });

  it("shows Pay in 4 as paused only when the checkout offered it and the guard is why", () => {
    const link = (over: Partial<PaymentLink>, session: Partial<NonNullable<PaymentLink["session"]>> = {}): PaymentLink => ({
      id: "cs_test_x",
      merchant: plan().merchant,
      description: "Headphones",
      amount: 350_000_000n,
      orderId: "hcp_1",
      modes: { now: true, later: null, subscription: null },
      successUrl: null,
      status: "open",
      session: { returnOrigin: "http://127.0.0.1:3600", cancelUrl: null, expiresAt: NOW + 3_600_000, payLaterUnavailable: null, creditGuard: null, preferredMode: "now", payment: null, ...session },
      ...over,
    });
    const paused = view({ state: "paused", paused: true, message: GUARD_PAUSED_MESSAGE });
    assert.equal(laterPausedMessage(link({}, { payLaterUnavailable: GUARD_PAUSED_MESSAGE, creditGuard: paused })), GUARD_PAUSED_MESSAGE);
    // Unavailable for another reason (the amount), or the guard open: no guard message.
    assert.equal(laterPausedMessage(link({}, { payLaterUnavailable: "Pay in 4 starts at $20.00.", creditGuard: view({}) })), null);
    assert.equal(laterPausedMessage(link({}, { payLaterUnavailable: null, creditGuard: null })), null);
  });
});

describe("a credit line's report", () => {
  // Judge finding: "Verified by Chainlink CRE" appeared for any report, a
  // local run through a mock forwarder and a simulator-signed one included.
  it("reads as verified only when the DON signed it; a simulated or local run says what it is", () => {
    assert.deepEqual(provenanceOf({ delivery: "don" }), { label: "Verified by Chainlink CRE", verified: true });
    assert.deepEqual(provenanceOf({ delivery: "simulation" }), { label: "Chainlink CRE (simulated)", verified: false });
    assert.deepEqual(provenanceOf({ delivery: "local" }), { label: "CRE workflow, local run", verified: false });
    assert.deepEqual(provenanceOf({ delivery: "unknown" }), { label: "CRE workflow report", verified: false });
    // An API that doesn't say who delivered it is never read as verified.
    assert.deepEqual(provenanceOf({}), { label: "CRE workflow report", verified: false });
  });
});
