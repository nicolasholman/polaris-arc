/**
 * The checks a replayed or live-indexed chain must pass: the indexed state
 * equals what the contracts themselves reported at the end of the recording
 * (test/fixtures/local-chain.json), every webhook kind was written, and the
 * totals equal a recount of the rows. Shared by replay.test.ts (the recorded
 * logs, simulated) and live.test.ts (the same chain, indexed over RPC).
 */

import { expect, it } from "vitest";
import type { TestIndexer } from "envio";

import type { Activity } from "../client/src/types.js";
import { toWebhookEvent } from "../client/src/webhooks.js";
import { validateWebhookEvent } from "../client/src/sdk-event-shape.js";
import { WEBHOOK_KINDS } from "../src/lib/util.js";

export type Recorded = {
  contract: string;
  event: string;
  srcAddress: string;
  blockNumber: number;
  timestamp: number;
  logIndex: number;
  txHash: string;
  txFrom: string;
  txTo: string | null;
  params: Record<string, string | boolean | string[]>;
};

export type Fixture = {
  chainId: number;
  /** The keeper EOA, the only sender of reports. */
  keeper: string;
  contracts: Record<string, string>;
  events: Recorded[];
  expected: {
    loans: Record<string, { status: number; installmentsPaid: number; totalRepaid: string; outstanding: string }>;
    subscriptions: Record<string, { status: number; nextChargeAt: number; periodsCharged: number; missedCharges: number }>;
    buyers: Record<string, { score: number; declined: boolean; underwritten: boolean; creditLimit: string; activeDebt: string; collateral: string }>;
    merchants: Record<string, { balance: string; registered: boolean; active: boolean; payoutAddress: string; maxOrderValue: string }>;
    sends: Record<string, { currency: "USD" | "EUR"; open: boolean }>;
    creditGuard: { minFreeCash: string; maxBadDebtBps: number; minOriginated: string; overrideMode: number; badDebtAcknowledged: string };
  };
};

const PLAN_STATUS = ["ACTIVE", "REPAID", "LIQUIDATED"];
const SUB_STATUS = ["ACTIVE", "CANCELLED", "LAPSED"];

/** The contracts as the indexer is configured for them (the replay maps the fixture's addresses onto these). */
export type Configured = { CollectionsReceiver: string; UnderwritingReceiver: string; CreditGuard: string };

/** Register the shared `it` blocks. `get` returns the indexer once it has run. */
export function chainChecks(get: () => TestIndexer, fixture: Fixture, configured: Configured): void {
  it("agrees with PolarisLoanEngine on every plan", async () => {
    for (const [id, loan] of Object.entries(fixture.expected.loans)) {
      const plan = await get().Plan.getOrThrow(id);
      expect(plan, `loan ${id}`).toMatchObject({
        status: PLAN_STATUS[loan.status],
        installmentsPaid: loan.installmentsPaid,
        totalRepaid: BigInt(loan.totalRepaid),
        outstanding: BigInt(loan.outstanding),
      });
      if (plan.status !== "ACTIVE") expect(plan.nextAttemptAt).toBeUndefined();
    }
  });

  it("agrees with PolarisPayments on every subscription", async () => {
    for (const [id, s] of Object.entries(fixture.expected.subscriptions)) {
      const sub = await get().Subscription.getOrThrow(id);
      expect(sub, `subscription ${id}`).toMatchObject({ status: SUB_STATUS[s.status], periodsCharged: s.periodsCharged, missedCharges: s.missedCharges });
      if (sub.status === "ACTIVE") expect(sub.nextChargeAt).toBe(s.nextChargeAt);
    }
  });

  it("agrees with ScoreManager, the vault and the engine on every credit line", async () => {
    for (const [address, b] of Object.entries(fixture.expected.buyers)) {
      const buyer = await get().Buyer.getOrThrow(address);
      expect(buyer, `buyer ${address}`).toMatchObject({
        score: b.score,
        declined: b.declined,
        underwritten: b.underwritten,
        creditLimit: BigInt(b.creditLimit),
        activeDebt: BigInt(b.activeDebt),
        collateral: BigInt(b.collateral),
      });
    }
  });

  it("agrees with the token and the registry on every merchant", async () => {
    for (const [address, m] of Object.entries(fixture.expected.merchants)) {
      const merchant = await get().Merchant.getOrThrow(address);
      expect(merchant, `merchant ${address}`).toMatchObject({
        balance: BigInt(m.balance),
        registered: m.registered,
        active: m.active,
        payoutAddress: m.payoutAddress,
        maxOrderValue: BigInt(m.maxOrderValue),
      });
    }
  });

  it("agrees with PolarisSend and PolarisSendEURC on every link", async () => {
    for (const [key, s] of Object.entries(fixture.expected.sends)) {
      const send = await get().Send.getOrThrow(key);
      expect(send.status === "OPEN", `link ${key}`).toBe(s.open);
      expect(send.currency, `link ${key}`).toBe(s.currency);
    }
    const statuses = (await get().Send.getAll()).map((s) => `${s.currency} ${s.status}`).sort();
    expect(statuses).toEqual(["EUR CLAIMED", "USD CANCELLED", "USD CLAIMED", "USD REFUNDED"]);
    const p = await get().Protocol.getOrThrow("polaris");
    const sum = (currency: string, event: string) =>
      fixture.events
        .filter((e) => e.contract === (currency === "EUR" ? "PolarisSendEURC" : "PolarisSend") && e.event === event)
        .reduce((n, e) => n + BigInt(e.params.amount as string), 0n);
    expect(p).toMatchObject({
      sendVolume: sum("USD", "Sent"),
      claimVolume: sum("USD", "Claimed"),
      eurcSendVolume: sum("EUR", "Sent"),
      eurcClaimVolume: sum("EUR", "Claimed"),
    });
  });

  it("agrees with CreditGuard on its settings", async () => {
    const g = fixture.expected.creditGuard;
    expect(await get().CreditGuard.getOrThrow("credit-guard")).toMatchObject({
      address: configured.CreditGuard,
      minFreeCash: BigInt(g.minFreeCash),
      maxBadDebtBps: g.maxBadDebtBps,
      minOriginated: BigInt(g.minOriginated),
      overrideMode: ["NONE", "FORCE_RESUME", "FORCE_PAUSE"][g.overrideMode],
      badDebtAcknowledged: BigInt(g.badDebtAcknowledged),
    });
    const overrides = (await get().ConfigChange.getAll()).filter((c) => c.contract === "CreditGuard" && c.event === "CreditGuardOverridden");
    expect(overrides).toHaveLength(fixture.events.filter((e) => e.event === "CreditGuardOverridden").length);
  });

  it("wrote every kind of webhook, each once per event that caused it", async () => {
    const activities = await get().Activity.getAll();
    expect(new Set(activities.map((a) => a.kind))).toEqual(new Set(WEBHOOK_KINDS));
    const cursors = activities.map((a) => a.cursor);
    expect(new Set(cursors).size).toBe(cursors.length);
    const count = (event: string) => fixture.events.filter((e) => `${e.contract}.${e.event}` === event).length;
    const kind = (k: string) => activities.filter((a) => a.kind === k).length;
    // One row per polarispay-sdk webhook: payment.succeeded is Pay now only,
    // Pay in 4 is plan.opened, a subscription is its charges.
    expect(kind("payment.succeeded")).toBe(count("PolarisPayments.PaymentMade"));
    expect(kind("plan.opened")).toBe(count("PolarisCheckout.PlanOpened"));
    expect(kind("subscription.charged")).toBe(count("PolarisPayments.SubscriptionCharged"));
    expect(kind("plan.completed")).toBe(count("PolarisLoanEngine.LoanFullyRepaid"));
    expect(kind("plan.liquidated")).toBe(count("PolarisLoanEngine.LoanLiquidated"));
    expect(kind("subscription.canceled")).toBe(count("PolarisPayments.SubscriptionCancelled") + count("PolarisPayments.SubscriptionLapsed"));
    // installment.collected: one per instalment completed, as the engine counts them.
    const completed = Object.values(fixture.expected.loans).reduce((n, l) => n + l.installmentsPaid, 0);
    expect(kind("installment.collected")).toBe(completed);
    // Every charge of a subscription that came through the checkout names its order.
    const started = new Set(fixture.events.filter((e) => e.event === "SubscriptionStarted").map((e) => String(e.params.subId)));
    const charges = activities.filter((a) => a.kind === "subscription.charged" && started.has(a.refId));
    expect(charges.length).toBeGreaterThan(0);
    for (const a of charges) expect(a.orderId, `subscription ${a.refId} period ${a.period}`).toBeTruthy();
  });

  it("turns every outbox row into an event polarispay-sdk accepts", async () => {
    const activities = await get().Activity.getAll();
    for (const row of activities) {
      // Hasura sends a missing column as null; the test indexer leaves it undefined.
      const a = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? null])) as unknown as Activity;
      const event = toWebhookEvent(a, { merchantId: "mer_live" });
      expect(validateWebhookEvent(event), `${a.kind} ${a.id}`).toEqual([]);
    }
  });

  it("explains every collection: executed, lost allowance, short on funds, or stale", async () => {
    const count = (contract: string, event: string, where: (e: Recorded) => boolean = () => true) =>
      fixture.events.filter((e) => e.contract === contract && e.event === event && where(e)).length;
    const tasks = await get().CollectionTask.getAll();
    expect(tasks.filter((t) => t.executed)).toHaveLength(count("CollectionsReceiver", "TaskExecuted"));
    const skipped = tasks.filter((t) => !t.executed).map((t) => [t.targetId, t.reason, t.reasonAction]);
    expect(skipped).toHaveLength(count("CollectionsReceiver", "TaskSkipped"));
    expect(skipped).toEqual(
      expect.arrayContaining([
        [2n, "InsufficientAllowance", "allowance_lost"], // the lost approval, signed again (Reauthorized)
        [3n, "InsufficientBalance", "insufficient_funds"], // buyer2's one-minute plan, then liquidated
        [1n, "LoanNotActive", "stale"],
      ]),
    );
    expect((await get().Installment.getOrThrow("2-0")).failedAttempts).toBe(1);
    expect((await get().Installment.getOrThrow("3-0")).failedAttempts).toBe(1);
    const runs = await get().CollectionRun.getAll();
    expect(runs).toHaveLength(count("CollectionsReceiver", "CollectionsRun"));
    expect(runs.every((r) => r.keeper === fixture.keeper)).toBe(true);
  });

  it("counts one keeper report per submitReport transaction", async () => {
    const reports = await get().KeeperReport.getAll();
    const txs = (contract: string, events: string[]) =>
      new Set(fixture.events.filter((e) => e.contract === contract && events.includes(e.event)).map((e) => e.txHash));
    const collections = txs("CollectionsReceiver", ["CollectionsRun"]);
    const underwriting = txs("UnderwritingReceiver", ["UnderwritingApplied", "UnderwritingRefused"]);
    expect(reports.filter((r) => r.kind === "collections")).toHaveLength(collections.size);
    expect(reports.filter((r) => r.kind === "underwriting")).toHaveLength(underwriting.size);
    for (const r of reports) {
      expect(r.keeper, r.id).toBe(fixture.keeper);
      expect(r.receiver, r.id).toBe(r.kind === "collections" ? configured.CollectionsReceiver : configured.UnderwritingReceiver);
    }
    expect((await get().Protocol.getOrThrow("polaris")).keeperReports).toBe(collections.size + underwriting.size);
  });

  it("recognises the gasless payouts, the quoted order and the refused underwriting", async () => {
    const payouts = await get().Payout.getAll();
    expect(payouts).toHaveLength(2);
    expect(payouts.filter((p) => p.toPayoutAddress)).toHaveLength(1);
    const quoted = (await get().Order.getAll()).filter((o) => o.quotedAmount !== undefined);
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toMatchObject({ status: "PAID", quoteMatched: true });
    const refused = (await get().Underwriting.getAll()).filter((u) => !u.applied);
    expect(refused.map((u) => u.refusal)).toEqual(["AlreadyHasRecord"]);
    const withheld = (await get().Repayment.getAll()).filter((r) => r.bonusWithheld);
    expect(withheld).toHaveLength(1);
  });

  it("keeps the protocol's totals equal to a recount of the rows", async () => {
    const p = await get().Protocol.getOrThrow("polaris");
    const payments = await get().Payment.getAll();
    expect(p.paymentCount).toBe(payments.length);
    expect(p.grossVolume).toBe(payments.reduce((s, x) => s + x.amount, 0n));
    const plans = await get().Plan.getAll();
    expect(p.activePlanCount).toBe(plans.filter((x) => x.status === "ACTIVE").length);
    expect(p.outstanding).toBe(plans.filter((x) => x.status === "ACTIVE").reduce((s, x) => s + x.outstanding, 0n));
    const merchants = await get().Merchant.getAll();
    expect(p.merchantCount).toBe(merchants.length);
    for (const m of merchants) {
      const mine = payments.filter((x) => x.merchant_id === m.id);
      expect(m.paymentCount, m.id).toBe(mine.length);
      expect(m.grossVolume, m.id).toBe(mine.reduce((s, x) => s + x.amount, 0n));
    }
    const subs = await get().Subscription.getAll();
    expect(p.activeSubscriptionCount).toBe(subs.filter((s) => s.status === "ACTIVE").length);
  });
}
