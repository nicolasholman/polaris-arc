/**
 * The Chainlink CRE `polaris-collections` workflow's reports, as the
 * CollectionsReceiver executed them: every task executed or skipped, and why.
 *
 * A skip for a shortfall puts the plan (or subscription) into dunning and
 * schedules its next attempt along the ladder, so the workflow does not pay
 * for a failing collection every minute; a stale candidate (not due, already
 * closed) is nobody's fault and changes nothing.
 *
 * Order inside one report: each task's own events (InstallmentPaid,
 * SubscriptionCharged, LoanLiquidated, ...) then its TaskExecuted or
 * TaskSkipped; then one CollectionsRun.
 */

import { indexer } from "envio";

import { configChange } from "../lib/config.js";
import { changePlan } from "../lib/domain.js";
import { installmentSlice, nextAttemptAfterFailure } from "../lib/loans.js";
import { decodeRevert } from "../lib/revert.js";
import { withStore } from "../lib/store.js";
import { COLLECTION_ACTION as ACTION, failureReasonOf, logId, toInt } from "../lib/util.js";

function actionName(action: number): string {
  switch (action) {
    case ACTION.COLLECT_INSTALLMENT:
      return "COLLECT_INSTALLMENT";
    case ACTION.CHARGE_SUBSCRIPTION:
      return "CHARGE_SUBSCRIPTION";
    case ACTION.LIQUIDATE:
      return "LIQUIDATE";
    default:
      return "UNKNOWN";
  }
}

indexer.onEvent({ contract: "CollectionsReceiver", event: "TaskExecuted" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const action = toInt(event.params.action);
    const id = event.params.id.toString();
    st.keep("CollectionTask", {
      id: logId(st.m.txHash, st.m.logIndex),
      action,
      actionName: actionName(action),
      targetId: event.params.id,
      executed: true,
      amount: action === ACTION.COLLECT_INSTALLMENT ? event.params.amount : undefined,
      reason: undefined,
      reasonAction: undefined,
      reasonData: undefined,
      have: undefined,
      need: undefined,
      plan_id: action === ACTION.CHARGE_SUBSCRIPTION ? undefined : id,
      subscription_id: action === ACTION.CHARGE_SUBSCRIPTION ? id : undefined,
      timestamp: st.m.timestamp,
      blockNumber: st.m.blockNumber,
      txHash: st.m.txHash,
    });
    if (action === ACTION.COLLECT_INSTALLMENT) (await st.protocol()).creCollections += 1;
  }),
);

indexer.onEvent({ contract: "CollectionsReceiver", event: "TaskSkipped" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const action = toInt(event.params.action);
    const id = event.params.id.toString();
    const why = decodeRevert(event.params.reason);
    st.keep("CollectionTask", {
      id: logId(st.m.txHash, st.m.logIndex),
      action,
      actionName: actionName(action),
      targetId: event.params.id,
      executed: false,
      amount: undefined,
      reason: why.name,
      reasonAction: why.action,
      reasonData: event.params.reason,
      have: why.have,
      need: why.need,
      plan_id: action === ACTION.CHARGE_SUBSCRIPTION ? undefined : id,
      subscription_id: action === ACTION.CHARGE_SUBSCRIPTION ? id : undefined,
      timestamp: st.m.timestamp,
      blockNumber: st.m.blockNumber,
      txHash: st.m.txHash,
    });
    // A stale candidate is not the buyer's failure; a failed liquidation is not a dunning step.
    if (why.action === "stale" || action === ACTION.LIQUIDATE) return;
    const ladder = st.settings.dunningRetrySeconds;

    if (action === ACTION.COLLECT_INSTALLMENT) {
      const plan = await st.find("Plan", id);
      if (!plan || plan.status !== "ACTIVE") return;
      // A skip before the attempt the ladder scheduled (the workflow sweeping
      // the chain when the indexer is down, another keeper) is the same miss,
      // not a new one: counting it would walk the buyer down the whole ladder
      // in minutes and send them a failure webhook a minute. The API counts
      // misses the same way.
      if (plan.dunning && plan.nextAttemptAt !== undefined && st.m.timestamp < plan.nextAttemptAt) return;
      await changePlan(st, plan, () => {
        plan.dunning = true;
        plan.failedAttempts += 1;
        plan.lastFailureReason = why.name;
        plan.lastFailureAction = why.action;
        plan.lastFailureAt = st.m.timestamp;
        plan.nextAttemptAt = nextAttemptAfterFailure(st.m.timestamp, plan.failedAttempts, ladder, plan.liquidatableAt);
      });
      const inst = await st.find("Installment", `${plan.id}-${plan.installmentsPaid}`);
      if (inst) {
        inst.failedAttempts += 1;
        inst.lastFailureReason = why.name;
        inst.lastFailureAt = st.m.timestamp;
      }
      const merchant = await st.merchant(plan.merchant_id);
      (await st.merchantDay(merchant)).failedCollections += 1;
      const index = Math.min(plan.installmentsPaid, plan.installmentCount - 1);
      // The ladder never waits past the moment the plan turns liquidatable;
      // when it would have, the next step is liquidation, not another try.
      const liquidationNext = plan.liquidatableAt !== undefined && plan.nextAttemptAt !== undefined && plan.nextAttemptAt >= plan.liquidatableAt;
      st.activity("installment.failed", merchant.id, {
        buyer: plan.buyer_id,
        orderId: plan.orderId,
        orderKey: plan.orderKey,
        refId: plan.id,
        amount: installmentSlice(plan.totalOwed, plan.installmentCount, index),
        installmentIndex: index,
        installmentCount: plan.installmentCount,
        attempt: plan.failedAttempts,
        nextAttemptAt: liquidationNext ? undefined : plan.nextAttemptAt,
        failureReason: failureReasonOf(why.action),
        reason: why.name,
        reasonAction: why.action,
      });
    } else if (action === ACTION.CHARGE_SUBSCRIPTION) {
      const sub = await st.find("Subscription", id);
      if (!sub || sub.status !== "ACTIVE") return;
      // As for instalments: a skip inside the current wait is the same miss.
      if (sub.failedAttempts > 0 && sub.nextAttemptAt !== undefined && st.m.timestamp < sub.nextAttemptAt) return;
      sub.failedAttempts += 1;
      sub.lastFailureReason = why.name;
      sub.lastFailureAt = st.m.timestamp;
      // PolarisPayments skips a period once its 7-day charge window passes, so
      // retrying beyond that only records a miss: cap the wait there.
      const windowEnd = sub.nextChargeAt === undefined ? undefined : sub.nextChargeAt + 7 * 86_400 + 1;
      sub.nextAttemptAt = nextAttemptAfterFailure(st.m.timestamp, sub.failedAttempts, ladder, windowEnd);
      sub.updatedAt = st.m.timestamp;
    }
  }),
);

indexer.onEvent({ contract: "CollectionsReceiver", event: "CollectionsRun" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { tasks, executed, skipped } = event.params;
    st.keep("CollectionRun", {
      id: logId(st.m.txHash, st.m.logIndex),
      tasks: toInt(tasks),
      executed: toInt(executed),
      skipped: toInt(skipped),
      transmitter: st.m.from,
      timestamp: st.m.timestamp,
      blockNumber: st.m.blockNumber,
      txHash: st.m.txHash,
    });
    const p = await st.protocol();
    p.collectionsRuns += 1;
    p.lastCollectionsRunAt = st.m.timestamp;
    p.lastCollectionsRunBlock = st.m.blockNumber;
    (await st.protocolDay()).collectionsRuns += 1;
  }),
);

/* ── Receiver settings (both receivers extend Chainlink's ReceiverTemplate) ── */

for (const contract of ["CollectionsReceiver", "UnderwritingReceiver"] as const) {
  indexer.onEvent({ contract, event: "ForwarderAddressUpdated" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "ForwarderAddressUpdated", { subject: event.params.newForwarder, value: event.params.previousForwarder });
    }),
  );
  indexer.onEvent({ contract, event: "ExpectedAuthorUpdated" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "ExpectedAuthorUpdated", { subject: event.params.newAuthor, value: event.params.previousAuthor });
    }),
  );
  indexer.onEvent({ contract, event: "ExpectedWorkflowNameUpdated" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "ExpectedWorkflowNameUpdated", { value: event.params.newName });
    }),
  );
  indexer.onEvent({ contract, event: "ExpectedWorkflowIdUpdated" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "ExpectedWorkflowIdUpdated", { value: event.params.newId });
    }),
  );
  indexer.onEvent({ contract, event: "SecurityWarning" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "SecurityWarning", { value: event.params.message });
    }),
  );
  indexer.onEvent({ contract, event: "OwnershipTransferred" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
    }),
  );
  // PolarisReceiver: while set, the only transaction origin that may deliver
  // reports (`cre workflow simulate --broadcast`); zero again for a DON.
  indexer.onEvent({ contract, event: "SimulationTransmitterSet" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "SimulationTransmitterSet", { subject: event.params.transmitter });
    }),
  );
}
