/**
 * Subscriptions: sign-up through the checkout, renewals charged by the CRE
 * collections workflow, a failed charge, a skipped period, a lapse and a
 * cancellation, with the merchant's recurring revenue kept exact.
 */

import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { A, account, RELAYER, SETTINGS, Sim, TRANSMITTER, USD } from "./sim.js";

const merchant = account(0x111);
const buyer = account(0x222);
const PERIOD = 60;
const price = USD(1);
const fee = (price * 50n) / 10_000n;
const orderKey = `0x${"cc".repeat(32)}`;
const errors = parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"]);

function subscribe(sim: Sim, subId: bigint, planId = 1n) {
  sim.tx({ from: RELAYER, to: A.PolarisCheckout });
  const nextChargeAt = sim.time + PERIOD;
  sim
    .transfer(buyer, merchant, price - fee)
    .log("PolarisPayments", "Subscribed", { subId, planId, subscriber: buyer })
    .log("PolarisPayments", "SubscriptionCharged", { subId, amount: price, fee, period: 1n })
    .log("PolarisCheckout", "SubscriptionStarted", {
      orderKey,
      merchant,
      buyer,
      subId,
      planId,
      orderId: "sub-order",
      pricePerPeriod: price,
      periodSeconds: BigInt(PERIOD),
      nextChargeAt: BigInt(nextChargeAt),
    });
  return nextChargeAt;
}

function charge(sim: Sim, subId: bigint, period: bigint) {
  sim
    .tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] })
    .transfer(buyer, merchant, price - fee)
    .log("PolarisPayments", "SubscriptionCharged", { subId, amount: price, fee, period })
    .log("CollectionsReceiver", "TaskExecuted", { action: 2n, id: subId, amount: 0n })
    .log("CollectionsReceiver", "CollectionsRun", { tasks: 1n, executed: 1n, skipped: 0n });
}

function plan(sim: Sim) {
  sim.tx({ from: RELAYER, to: A.PolarisPayments }).log("PolarisPayments", "PlanCreated", { planId: 1n, merchant, price, period: BigInt(PERIOD) });
}

describe("Subscriptions", () => {
  it("signs up through the checkout, then renews on schedule", async () => {
    const sim = new Sim().registerMerchant(merchant);
    plan(sim);
    const next = subscribe(sim, 1n);
    await sim.run();

    let sub = await sim.indexer.Subscription.getOrThrow("1");
    expect(sub).toMatchObject({ status: "ACTIVE", orderId: "sub-order", nextChargeAt: next, nextAttemptAt: next, periodsCharged: 1, totalCharged: price });
    expect(await sim.indexer.Payment.getOrThrow("sub-1-1")).toMatchObject({ mode: "SUBSCRIPTION", period: 1, orderId: "sub-order", orderKey, viaCheckout: true, fee });
    expect(await sim.indexer.Order.getOrThrow(orderKey)).toMatchObject({ status: "PAID", kind: "SUBSCRIPTION", subscription_id: "1" });
    // $1 a minute is $43,200 a month.
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({ activeSubscriptionCount: 1, mrr: USD(43_200), subscriptionChargeCount: 1, balance: price - fee });
    expect(await sim.indexer.SubscriptionPlan.getOrThrow("1")).toMatchObject({ subscriberCount: 1, activeSubscriberCount: 1 });

    sim.wait(PERIOD);
    charge(sim, 1n, 2n);
    await sim.run();
    sub = await sim.indexer.Subscription.getOrThrow("1");
    expect(sub).toMatchObject({ periodsCharged: 2, nextChargeAt: next + PERIOD, nextAttemptAt: next + PERIOD, totalCharged: 2n * price });
    // polarispay-sdk announces a subscription through its charges, the first included, each with its order.
    const charges = (await sim.indexer.Activity.getAll()).sort((a, b) => (a.cursor < b.cursor ? -1 : 1));
    expect(charges.map((a) => a.kind)).toEqual(["subscription.charged", "subscription.charged"]);
    expect(charges.map((a) => [a.period, a.nextChargeAt, a.orderId, a.orderKey, a.subscriptionPlanId, a.amount, a.fee])).toEqual([
      [1, next, "sub-order", orderKey, "1", price, fee],
      [2, next + PERIOD, "sub-order", orderKey, "1", price, fee],
    ]);
  });

  it("backs off after a failed charge, and skips to the next boundary after a missed window", async () => {
    const sim = new Sim().registerMerchant(merchant);
    plan(sim);
    const next = subscribe(sim, 1n);
    sim.wait(PERIOD);
    sim
      .tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] })
      .log("CollectionsReceiver", "TaskSkipped", {
        action: 2n,
        id: 1n,
        reason: encodeErrorResult({ abi: errors, errorName: "ERC20InsufficientBalance", args: [buyer, 0n, price] }),
      });
    await sim.run();
    const failedAt = sim.time;
    let sub = await sim.indexer.Subscription.getOrThrow("1");
    expect(sub).toMatchObject({ failedAttempts: 1, lastFailureReason: "ERC20InsufficientBalance", nextAttemptAt: failedAt + SETTINGS.dunningRetrySeconds[0]! });

    // Tried again a minute later, inside the wait: the same miss.
    sim.wait(60);
    sim
      .tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] })
      .log("CollectionsReceiver", "TaskSkipped", {
        action: 2n,
        id: 1n,
        reason: encodeErrorResult({ abi: errors, errorName: "ERC20InsufficientBalance", args: [buyer, 0n, price] }),
      });
    await sim.run();
    sub = await sim.indexer.Subscription.getOrThrow("1");
    expect(sub).toMatchObject({ failedAttempts: 1, lastFailureAt: failedAt, nextAttemptAt: failedAt + SETTINGS.dunningRetrySeconds[0]! });

    // Eight days later chargeDue records a miss and moves to the next boundary.
    sim.wait(8 * 86_400);
    sim.tx({ from: TRANSMITTER }).log("PolarisPayments", "ChargeMissed", { subId: 1n, misses: 1n, reason: "charge window elapsed" });
    await sim.run();
    const periods = Math.floor((sim.time - next) / PERIOD) + 1;
    sub = await sim.indexer.Subscription.getOrThrow("1");
    expect(sub).toMatchObject({ missedCharges: 1, failedAttempts: 0, nextChargeAt: next + periods * PERIOD });
    expect(sub.nextChargeAt! > sim.time).toBe(true);
  });

  it("ends on a lapse or a cancellation, and the recurring revenue goes with it", async () => {
    const sim = new Sim().registerMerchant(merchant);
    plan(sim);
    subscribe(sim, 1n);
    subscribe(sim, 2n);
    sim.tx({ from: TRANSMITTER }).log("PolarisPayments", "SubscriptionLapsed", { subId: 1n, misses: 3n });
    sim.tx({ from: RELAYER }).log("PolarisPayments", "SubscriptionCancelled", { subId: 2n, by: buyer });
    await sim.run();

    expect(await sim.indexer.Subscription.getOrThrow("1")).toMatchObject({ status: "LAPSED", nextAttemptAt: undefined });
    expect(await sim.indexer.Subscription.getOrThrow("2")).toMatchObject({ status: "CANCELLED", cancelledBy: buyer });
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({ activeSubscriptionCount: 0, mrr: 0n });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ subscriptionCount: 2, activeSubscriptionCount: 0 });
    const ended = (await sim.indexer.Activity.getAll()).filter((a) => a.kind === "subscription.canceled").sort((a, b) => (a.cursor < b.cursor ? -1 : 1));
    expect(ended.map((a) => [a.refId, a.canceledBy, a.reason, a.subscriptionPlanId])).toEqual([
      ["1", "lapsed", "lapsed", "1"],
      ["2", "subscriber", "cancelled by the buyer", "1"],
    ]);
  });
});
