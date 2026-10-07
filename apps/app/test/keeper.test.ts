import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { duePayment, owedOnOpenPlans, plansNeedingSignature, signAgainState } from "../src/lib/collection.ts";
import { GUARD_PAUSED_MESSAGE, laterPausedMessage, toGuardView } from "../src/lib/credit-guard.ts";
import type { CreditGuardView, PaymentLink, Plan } from "../src/lib/data/types.ts";
import { KEEPER_REVIEW_LABEL, provenanceOf } from "../src/lib/provenance.ts";

/**
 * The keeper and credit-guard states the app shows: the credit guard (open,
 * or paused for low pool cash, bad debt or the owner's pause), a plan's
 * collection after a lost approval (sign again, collecting, collected), and
 * the report behind a credit line. Pure functions over what Polaris for
 * Business serves; the screens only lay them out.
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

describe("the credit guard", () => {
  const view = (over: Partial<CreditGuardView>): CreditGuardView => ({ state: "open", paused: false, reasons: [], message: null, readAt: NOW, ...over });

  it("takes the API's guard, with the buyer's words and its reasons while paused", () => {
    const paused = toGuardView({ state: "paused", paused: true, reasons: ["low_cash", "bad_debt"], message: null, ageSeconds: null, readAt: new Date(NOW).toISOString() });
    assert.deepEqual(paused, { state: "paused", paused: true, reasons: ["low_cash", "bad_debt"], message: GUARD_PAUSED_MESSAGE, readAt: NOW });
    assert.equal(GUARD_PAUSED_MESSAGE, "Pay in 4 is paused by our credit guard; pay now works as usual.");
    const open = toGuardView({ state: "open", paused: false, reasons: [], message: "ignored", ageSeconds: null, readAt: new Date(NOW).toISOString() });
    assert.equal(open.message, null);
    assert.deepEqual(open.reasons, []);
  });

  it("keeps only the reasons Arc's guard has (the Chainlink peg check's included), and reads an older API's stale states as open", () => {
    const g = toGuardView({ state: "paused", paused: true, reasons: ["depeg", "owner_pause", "stale_price", "attestation_expired"], readAt: new Date(NOW).toISOString() });
    assert.deepEqual(g.reasons, ["depeg", "owner_pause", "stale_price"]);
    assert.equal(toGuardView({ state: "stale", paused: false, ageSeconds: 4320, readAt: new Date(NOW).toISOString() }).state, "open");
    assert.equal(toGuardView({ state: "unconfigured", paused: false, readAt: new Date(NOW).toISOString() }).state, "unconfigured");
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
  it("reads as reviewed by the Polaris keeper when there is a report transaction", () => {
    assert.equal(KEEPER_REVIEW_LABEL, "Reviewed by the Polaris keeper");
    assert.deepEqual(provenanceOf({ by: "Polaris keeper", txHash: TX }), { label: "Reviewed by the Polaris keeper", verified: true });
  });

  it("never claims a review without a transaction to point at", () => {
    assert.deepEqual(provenanceOf({ by: "Polaris keeper", txHash: "0x" as `0x${string}` }), { label: "Underwriting report", verified: false });
    assert.deepEqual(provenanceOf({ by: "someone else" as "Polaris keeper", txHash: TX }), { label: "Underwriting report", verified: false });
  });
});
