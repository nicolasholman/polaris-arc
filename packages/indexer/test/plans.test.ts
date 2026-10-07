/**
 * Pay in 4 from origination to the end: the schedule, the CRE collections
 * workflow's skips and collections, dunning and its ladder, prepaying, and
 * liquidation. Every total is checked against what a recount would give.
 */

import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { interestFor, installmentSlice } from "../src/lib/loans.js";
import { A, account, RELAYER, SETTINGS, Sim, TRANSMITTER, USD } from "./sim.js";

const merchant = account(0x111);
const buyer = account(0x222);
const WEEK = 7 * 86_400;
const errors = parseAbi(["error InsufficientBalance(uint256 have, uint256 need)", "error NotDue()"]);

const principal = USD(200);
const totalOwed = principal + interestFor(principal, 4, WEEK);
const first = installmentSlice(totalOwed, 4, 0);

function open(sim: Sim, loanId: bigint, orderKey: string, orderId: string, interval = WEEK) {
  sim.tx({ from: RELAYER, to: A.PolarisCheckout });
  const firstDueAt = sim.time + interval;
  const owed = principal + interestFor(principal, 4, interval);
  sim
    .transfer(A.PolarisLoanEngine, merchant, principal)
    .log("PolarisLoanEngine", "LoanCreated", { loanId, borrower: buyer, merchant, principal, totalOwed: owed, installments: 4n })
    .log("PolarisCheckout", "PlanOpened", {
      orderKey,
      merchant,
      buyer,
      loanId,
      orderId,
      principal,
      totalOwed: owed,
      installments: 4n,
      interval: BigInt(interval),
      firstDueAt: BigInt(firstDueAt),
    });
  return firstDueAt;
}

/** The events one collections report leaves, simulated here (no CRE workflow or DON runs in this test). */
function report(sim: Sim, body: (sim: Sim) => void, tasks: number, executed: number) {
  sim.tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] });
  body(sim);
  sim
    .log("CollectionsReceiver", "CollectionsRun", { tasks: BigInt(tasks), executed: BigInt(executed), skipped: BigInt(tasks - executed) })
    .log("CreForwarder", "ReportProcessed", {
      receiver: A.CollectionsReceiver,
      workflowExecutionId: `0x${"ee".repeat(32)}`,
      reportId: "0x0001",
      result: true,
    });
}

describe("Pay in 4", () => {
  it("opens with a full schedule, and pays the merchant the principal at once", async () => {
    const sim = new Sim().registerMerchant(merchant);
    const firstDueAt = open(sim, 1n, `0x${"aa".repeat(32)}`, "logo-work");
    await sim.run();

    const plan = await sim.indexer.Plan.getOrThrow("1");
    expect(plan).toMatchObject({
      status: "ACTIVE",
      orderId: "logo-work",
      principal,
      totalOwed: 201_534_246n,
      interest: 1_534_246n,
      installmentCount: 4,
      installmentAmount: 50_383_562n,
      interval: WEEK,
      firstDueAt,
      nextDueAt: firstDueAt,
      nextAttemptAt: firstDueAt,
      liquidatableAt: firstDueAt + SETTINGS.graceSeconds + 1,
      installmentsPaid: 0,
      outstanding: totalOwed,
      relayer: RELAYER,
    });
    const installments = (await sim.indexer.Installment.getAll()).sort((a, b) => a.index - b.index);
    expect(installments.map((i) => i.dueAt)).toEqual([0, 1, 2, 3].map((i) => firstDueAt + i * WEEK));
    expect(installments.reduce((s, i) => s + i.amount, 0n)).toBe(totalOwed);

    expect(await sim.indexer.Payment.getOrThrow(`0x${"aa".repeat(32)}`)).toMatchObject({ mode: "PAY_IN_4", amount: principal, fee: 0n, plan_id: "1" });
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({
      name: "Studio Sur",
      planCount: 1,
      planVolume: principal,
      activePlanCount: 1,
      outstanding: totalOwed,
      balance: principal,
    });
    expect(await sim.indexer.Buyer.getOrThrow(buyer)).toMatchObject({ activeDebt: totalOwed, planCount: 1, activePlanCount: 1 });
    // polarispay-sdk announces a Pay in 4 order as plan.opened alone, with its schedule.
    const activities = await sim.indexer.Activity.getAll();
    expect(activities.map((a) => a.kind)).toEqual(["plan.opened"]);
    expect(activities[0]).toMatchObject({
      refId: "1",
      orderId: "logo-work",
      amount: totalOwed,
      principal,
      installmentCount: 4,
      interval: WEEK,
      firstDueAt,
      buyer,
    });
  });

  it("duns a short buyer along the ladder, then clears it when CRE collects", async () => {
    const sim = new Sim().registerMerchant(merchant);
    const firstDueAt = open(sim, 1n, `0x${"aa".repeat(32)}`, "logo-work");
    await sim.run();

    // Due, and the buyer is short: the receiver skips with the engine's reason.
    sim.wait(WEEK);
    report(
      sim,
      (s) => s.log("CollectionsReceiver", "TaskSkipped", { action: 1n, id: 1n, reason: encodeErrorResult({ abi: errors, errorName: "InsufficientBalance", args: [USD(10), first] }) }),
      1,
      0,
    );
    await sim.run();
    const failedAt = sim.time;

    let plan = await sim.indexer.Plan.getOrThrow("1");
    expect(plan).toMatchObject({ dunning: true, failedAttempts: 1, lastFailureReason: "InsufficientBalance", lastFailureAction: "insufficient_funds", lastFailureAt: failedAt });
    // The ladder's first step (6 h) is past the grace period here, so the next
    // try is when the plan turns liquidatable.
    expect(plan.nextAttemptAt).toBe(Math.min(failedAt + SETTINGS.dunningRetrySeconds[0]!, firstDueAt + SETTINGS.graceSeconds + 1));
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({ dunningPlanCount: 1, atRiskOutstanding: totalOwed });
    expect(await sim.indexer.Installment.getOrThrow("1-0")).toMatchObject({ failedAttempts: 1, lastFailureReason: "InsufficientBalance", status: "PENDING" });
    const failed = (await sim.indexer.Activity.getAll()).find((a) => a.kind === "installment.failed");
    expect(failed).toMatchObject({
      reason: "InsufficientBalance",
      reasonAction: "insufficient_funds",
      failureReason: "insufficient_funds",
      amount: first,
      installmentIndex: 0,
      installmentCount: 4,
      attempt: 1,
      refId: "1",
    });
    // The ladder would wait past the grace period, so the next step is liquidation.
    expect(failed!.nextAttemptAt).toBeUndefined();
    const [task] = await sim.indexer.CollectionTask.getAll();
    expect(task).toMatchObject({ executed: false, actionName: "COLLECT_INSTALLMENT", reason: "InsufficientBalance", have: USD(10), need: first, plan_id: "1" });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ collectionsRuns: 1, lastCollectionsRunAt: failedAt, creReports: 1 });

    // A stale candidate changes nothing.
    report(sim, (s) => s.log("CollectionsReceiver", "TaskSkipped", { action: 1n, id: 1n, reason: encodeErrorResult({ abi: errors, errorName: "NotDue" }) }), 1, 0);
    await sim.run();
    expect((await sim.indexer.Plan.getOrThrow("1")).failedAttempts).toBe(1);

    // The buyer topped up; CRE collects instalment 1.
    report(
      sim,
      (s) =>
        s
          .log("PolarisLoanEngine", "InstallmentPaid", { loanId: 1n, borrower: buyer, installmentIndex: 0n, amount: first, onTime: true })
          .log("PolarisLoanEngine", "InstallmentCollected", { loanId: 1n, caller: A.CollectionsReceiver, amount: first })
          .log("CollectionsReceiver", "TaskExecuted", { action: 1n, id: 1n, amount: first }),
      1,
      1,
    );
    await sim.run();

    plan = await sim.indexer.Plan.getOrThrow("1");
    expect(plan).toMatchObject({
      dunning: false,
      failedAttempts: 0,
      installmentsPaid: 1,
      totalRepaid: first,
      outstanding: totalOwed - first,
      nextDueAt: firstDueAt + WEEK,
      nextAttemptAt: firstDueAt + WEEK,
      liquidatableAt: firstDueAt + WEEK + SETTINGS.graceSeconds + 1,
    });
    expect(await sim.indexer.Installment.getOrThrow("1-0")).toMatchObject({ status: "PAID", paid: first, paidBy: "CRE", onTime: true });
    const [repayment] = await sim.indexer.Repayment.getAll();
    expect(repayment).toMatchObject({ source: "CRE", installmentsCompleted: 1, amount: first });
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({ dunningPlanCount: 0, atRiskOutstanding: 0n, outstanding: totalOwed - first });
    expect(await sim.indexer.Buyer.getOrThrow(buyer)).toMatchObject({ activeDebt: totalOwed - first, onTimeInstallments: 1 });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ creCollections: 1, installmentsCompleted: 1, outstanding: totalOwed - first });
  });

  it("counts a skip before the scheduled retry as the same miss, not a new one", async () => {
    const sim = new Sim().registerMerchant(merchant);
    const firstDueAt = open(sim, 1n, `0x${"aa".repeat(32)}`, "logo-work");
    const short = encodeErrorResult({ abi: errors, errorName: "InsufficientBalance", args: [USD(10), first] });
    sim.wait(WEEK + 10);
    report(sim, (s) => s.log("CollectionsReceiver", "TaskSkipped", { action: 1n, id: 1n, reason: short }), 1, 0);
    await sim.run();
    const retryAt = (await sim.indexer.Plan.getOrThrow("1")).nextAttemptAt!;
    expect(retryAt).toBe(firstDueAt + SETTINGS.graceSeconds + 1);

    // The workflow sweeping the chain (its indexer is down) tries again a minute later.
    sim.wait(60);
    report(sim, (s) => s.log("CollectionsReceiver", "TaskSkipped", { action: 1n, id: 1n, reason: short }), 1, 0);
    await sim.run();
    expect(sim.time < retryAt).toBe(true);
    expect(await sim.indexer.Plan.getOrThrow("1")).toMatchObject({ failedAttempts: 1, nextAttemptAt: retryAt });
    expect((await sim.indexer.Installment.getOrThrow("1-0")).failedAttempts).toBe(1);
    expect((await sim.indexer.Activity.getAll()).filter((a) => a.kind === "installment.failed")).toHaveLength(1);
    // Both skips are still on record.
    expect(await sim.indexer.CollectionTask.getAll()).toHaveLength(2);
  });

  it("counts a partial payment toward the instalment without completing it", async () => {
    const sim = new Sim().registerMerchant(merchant);
    open(sim, 1n, `0x${"aa".repeat(32)}`, "o");
    sim.tx({ from: RELAYER, to: A.PolarisLoanEngine }).log("PolarisLoanEngine", "InstallmentPaid", { loanId: 1n, borrower: buyer, installmentIndex: 0n, amount: USD(10), onTime: true });
    await sim.run();
    expect(await sim.indexer.Plan.getOrThrow("1")).toMatchObject({ installmentsPaid: 0, totalRepaid: USD(10) });
    expect(await sim.indexer.Installment.getOrThrow("1-0")).toMatchObject({ status: "PENDING", paid: USD(10) });
    expect((await sim.indexer.Activity.getAll()).some((a) => a.kind === "installment.collected")).toBe(false);
  });

  it("closes a plan the buyer prepays in one payment", async () => {
    const sim = new Sim().registerMerchant(merchant);
    open(sim, 1n, `0x${"aa".repeat(32)}`, "o");
    sim
      .tx({ from: RELAYER, to: A.PolarisLoanEngine })
      .log("PolarisLoanEngine", "InstallmentPaid", { loanId: 1n, borrower: buyer, installmentIndex: 0n, amount: totalOwed, onTime: true })
      .log("PolarisLoanEngine", "LoanFullyRepaid", { loanId: 1n, borrower: buyer });
    await sim.run();

    const plan = await sim.indexer.Plan.getOrThrow("1");
    expect(plan).toMatchObject({ status: "REPAID", installmentsPaid: 4, outstanding: 0n, nextDueAt: undefined, nextAttemptAt: undefined, liquidatableAt: undefined });
    const installments = await sim.indexer.Installment.getAll();
    expect(installments.every((i) => i.status === "PAID" && i.paidBy === "BUYER")).toBe(true);
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({ activePlanCount: 0, outstanding: 0n, repaidPlanCount: 1 });
    expect(await sim.indexer.Buyer.getOrThrow(buyer)).toMatchObject({ activeDebt: 0n, activePlanCount: 0, onTimeInstallments: 4 });
    const activities = (await sim.indexer.Activity.getAll()).sort((a, b) => (a.cursor < b.cursor ? -1 : 1));
    expect(activities.map((a) => a.kind)).toEqual([
      "plan.opened",
      "installment.collected",
      "installment.collected",
      "installment.collected",
      "installment.collected",
      "plan.completed",
    ]);
    // One webhook per instalment the prepayment completed, each with its own amount.
    const collected = activities.filter((a) => a.kind === "installment.collected");
    const slices = [0, 1, 2, 3].map((i) => installmentSlice(totalOwed, 4, i));
    expect(collected.map((a) => a.installmentIndex)).toEqual([0, 1, 2, 3]);
    expect(collected.map((a) => a.amount)).toEqual(slices);
    expect(collected.map((a) => a.remaining)).toEqual([totalOwed - slices[0]!, slices[2]! + slices[3]!, slices[3]!, 0n]);
    expect(activities.at(-1)).toMatchObject({ kind: "plan.completed", amount: totalOwed });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ activePlanCount: 0, outstanding: 0n, repaidVolume: totalOwed });
  });

  it("writes off what liquidation could not recover", async () => {
    const sim = new Sim().registerMerchant(merchant);
    open(sim, 7n, `0x${"bb".repeat(32)}`, "o", 60);
    sim.wait(60 + SETTINGS.graceSeconds + 2);
    const owed = principal + interestFor(principal, 4, 60);
    report(
      sim,
      (s) =>
        s
          .log("ScoreManager", "ScoreChanged", { user: buyer, oldScore: 600n, newScore: 450n, reason: "liquidation" })
          .log("PolarisLoanEngine", "LoanLiquidated", { loanId: 7n, borrower: buyer, outstanding: owed, recovered: USD(20) })
          .log("CollectionsReceiver", "TaskExecuted", { action: 3n, id: 7n, amount: 0n }),
      1,
      1,
    );
    await sim.run();

    expect(await sim.indexer.Plan.getOrThrow("7")).toMatchObject({ status: "LIQUIDATED", recovered: USD(20), loss: owed - USD(20), outstanding: owed - USD(20) });
    expect((await sim.indexer.Installment.getAll()).every((i) => i.status === "WRITTEN_OFF")).toBe(true);
    expect(await sim.indexer.Buyer.getOrThrow(buyer)).toMatchObject({ liquidations: 1, activeDebt: 0n, score: 450 });
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({ liquidatedPlanCount: 1, activePlanCount: 0, outstanding: 0n });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ liquidationCount: 1, lossVolume: owed - USD(20) });
    const liquidated = (await sim.indexer.Activity.getAll()).find((a) => a.kind === "plan.liquidated");
    expect(liquidated).toMatchObject({ refId: "7", amount: owed, recovered: USD(20) });
  });
});
