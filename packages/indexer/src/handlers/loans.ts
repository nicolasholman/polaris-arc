/**
 * PolarisLoanEngine: Pay in 4 plans from origination to repaid or
 * liquidated, every payment toward them, and who collected it.
 *
 * Event order inside one transaction, which these handlers rely on:
 *   openPlan:            LoanCreated, then PolarisCheckout.PlanOpened
 *   collectInstallment:  InstallmentPaid, [OnTimeBonusWithheld], [LoanFullyRepaid], InstallmentCollected
 *   repay/repayWithSig:  InstallmentPaid, [OnTimeBonusWithheld], [LoanFullyRepaid]
 *   liquidate:           [CollateralSeized], ScoreChanged, [DeclinedForDefaults], LoanLiquidated
 */

import { indexer } from "envio";

import { configChange } from "../lib/config.js";
import { changePlan } from "../lib/domain.js";
import { dueAt, installmentSlice, installmentsEarned, paidToward, thresholdFor } from "../lib/loans.js";
import { withStore } from "../lib/store.js";
import { logId, toInt } from "../lib/util.js";

indexer.onEvent({ contract: "PolarisLoanEngine", event: "LoanCreated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { loanId, borrower, merchant, principal, totalOwed, installments } = event.params;
    const m = await st.merchant(merchant);
    const b = await st.buyer(borrower);
    const plan = st.keep("Plan", {
      id: loanId.toString(),
      loanId,
      merchant_id: m.id,
      buyer_id: b.id,
      orderId: undefined,
      orderKey: undefined,
      principal,
      totalOwed,
      interest: totalOwed - principal,
      installmentCount: toInt(installments),
      installmentAmount: 0n,
      interval: 0,
      startedAt: st.m.timestamp,
      firstDueAt: undefined,
      totalRepaid: 0n,
      outstanding: totalOwed,
      installmentsPaid: 0,
      // The schedule arrives with PlanOpened (the engine's event carries no interval).
      nextDueAt: undefined,
      liquidatableAt: undefined,
      nextAttemptAt: undefined,
      status: "PENDING",
      dunning: false,
      failedAttempts: 0,
      lastFailureReason: undefined,
      lastFailureAction: undefined,
      lastFailureAt: undefined,
      recovered: 0n,
      loss: 0n,
      closedAt: undefined,
      openedTxHash: st.m.txHash,
      openedBlock: st.m.blockNumber,
      relayer: st.m.from,
      lastRepaymentId: undefined,
      updatedAt: st.m.timestamp,
    });
    await changePlan(st, plan, () => {
      plan.status = "ACTIVE";
    });
    m.planCount += 1;
    m.planVolume += principal;
    b.planCount += 1;
    const p = await st.protocol();
    p.planCount += 1;
    p.principalOriginated += principal;
    const pd = await st.protocolDay();
    pd.planCount += 1;
    pd.principalOriginated += principal;
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "InstallmentPaid" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { loanId, borrower, installmentIndex, amount, onTime } = event.params;
    const plan = await st.find("Plan", loanId.toString());
    if (!plan) {
      st.warn(`InstallmentPaid for unknown loan ${loanId}`);
      return;
    }
    const before = plan.installmentsPaid;
    let completed = 0;
    await changePlan(st, plan, () => {
      plan.totalRepaid += amount;
      plan.outstanding = plan.totalOwed - plan.totalRepaid;
      plan.installmentsPaid = installmentsEarned(plan.totalOwed, plan.installmentCount, plan.totalRepaid);
      completed = plan.installmentsPaid - before;
      if (completed > 0) {
        // A completed instalment ends any dunning on it.
        plan.dunning = false;
        plan.failedAttempts = 0;
        plan.lastFailureAction = undefined;
      }
      if (plan.firstDueAt !== undefined && plan.installmentsPaid < plan.installmentCount) {
        plan.nextDueAt = dueAt(plan.firstDueAt, plan.interval, plan.installmentsPaid);
        plan.liquidatableAt = plan.nextDueAt + st.settings.graceSeconds + 1;
        if (!plan.dunning) plan.nextAttemptAt = plan.nextDueAt;
      }
    });

    // Every instalment this payment touched: completed ones are PAID; the next
    // one shows what has been paid toward it so far.
    const last = Math.min(plan.installmentsPaid, plan.installmentCount - 1);
    for (let i = toInt(installmentIndex); i <= last; i++) {
      const inst = await st.find("Installment", `${plan.id}-${i}`);
      if (!inst) continue;
      inst.paid = paidToward(plan.totalOwed, plan.installmentCount, i, plan.totalRepaid);
      if (i < plan.installmentsPaid && inst.status !== "PAID") {
        inst.status = "PAID";
        inst.paidAt = st.m.timestamp;
        // The engine judges the instalment it was paying toward; any later
        // one this payment also completed was paid early.
        inst.onTime = i === toInt(installmentIndex) ? onTime : true;
        inst.paidBy = "BUYER";
        inst.paidTxHash = st.m.txHash;
      }
    }

    const repaymentId = logId(st.m.txHash, st.m.logIndex);
    st.keep("Repayment", {
      id: repaymentId,
      plan_id: plan.id,
      buyer: borrower,
      amount,
      installmentIndex: toInt(installmentIndex),
      installmentsCompleted: completed,
      onTime,
      source: "BUYER",
      bonusWithheld: false,
      relayer: st.m.from,
      timestamp: st.m.timestamp,
      blockNumber: st.m.blockNumber,
      txHash: st.m.txHash,
    });
    plan.lastRepaymentId = repaymentId;

    const buyer = await st.buyer(borrower);
    if (completed > 0) {
      if (onTime) buyer.onTimeInstallments += completed;
      else {
        buyer.lateInstallments += 1;
        buyer.onTimeInstallments += completed - 1;
      }
    }
    (await st.buyerDay(buyer)).repaid += amount;

    const merchant = await st.merchant(plan.merchant_id);
    const day = await st.merchantDay(merchant);
    day.installmentsCompleted += completed;
    day.repaidVolume += amount;

    const p = await st.protocol();
    p.repaidVolume += amount;
    p.installmentsCompleted += completed;
    const pd = await st.protocolDay();
    pd.repaidVolume += amount;
    pd.installmentsCompleted += completed;

    // polarispay-sdk sends installment.collected once per instalment a payment
    // completes (a prepayment of the whole plan sends one per instalment),
    // with that instalment's own amount and what is still owed after it.
    for (let k = before; k < plan.installmentsPaid; k++) {
      const last = k + 1 === plan.installmentsPaid;
      const remaining = last ? plan.outstanding : plan.totalOwed - thresholdFor(plan.totalOwed, plan.installmentCount, k + 1);
      st.activity(
        "installment.collected",
        merchant.id,
        {
          buyer: borrower,
          orderId: plan.orderId,
          orderKey: plan.orderKey,
          refId: plan.id,
          amount: installmentSlice(plan.totalOwed, plan.installmentCount, k),
          installmentIndex: k,
          installmentCount: plan.installmentCount,
          remaining: remaining > 0n ? remaining : 0n,
        },
        k - before,
      );
    }
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "InstallmentCollected" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { loanId, caller } = event.params;
    const plan = await st.find("Plan", loanId.toString());
    if (!plan?.lastRepaymentId) return;
    const source = caller === st.settings.addresses.CollectionsReceiver ? "CRE" : "KEEPER";
    const repayment = await st.find("Repayment", plan.lastRepaymentId);
    if (repayment && repayment.txHash === st.m.txHash) repayment.source = source;
    for (let i = 0; i < plan.installmentCount; i++) {
      const inst = await st.find("Installment", `${plan.id}-${i}`);
      if (inst && inst.paidTxHash === st.m.txHash) inst.paidBy = source;
    }
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "OnTimeBonusWithheld" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const plan = await st.find("Plan", event.params.loanId.toString());
    if (!plan?.lastRepaymentId) return;
    const repayment = await st.find("Repayment", plan.lastRepaymentId);
    if (repayment && repayment.txHash === st.m.txHash) repayment.bonusWithheld = true;
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "LoanFullyRepaid" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const plan = await st.find("Plan", event.params.loanId.toString());
    if (!plan) return;
    await changePlan(st, plan, () => {
      plan.status = "REPAID";
      plan.dunning = false;
      plan.closedAt = st.m.timestamp;
      plan.nextDueAt = undefined;
      plan.liquidatableAt = undefined;
      plan.nextAttemptAt = undefined;
    });
    (await st.merchant(plan.merchant_id)).repaidPlanCount += 1;
    st.activity("plan.completed", plan.merchant_id, {
      buyer: plan.buyer_id,
      orderId: plan.orderId,
      orderKey: plan.orderKey,
      refId: plan.id,
      amount: plan.totalOwed,
    });
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "LoanLiquidated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { loanId, borrower, outstanding, recovered } = event.params;
    const plan = await st.find("Plan", loanId.toString());
    if (!plan) return;
    await changePlan(st, plan, () => {
      plan.status = "LIQUIDATED";
      plan.dunning = false;
      plan.recovered = recovered;
      plan.loss = outstanding - recovered;
      plan.totalRepaid += recovered;
      // PolarisLoanEngine.outstandingOf after liquidation: the unrecovered part.
      plan.outstanding = plan.totalOwed - plan.totalRepaid;
      plan.closedAt = st.m.timestamp;
      plan.nextDueAt = undefined;
      plan.liquidatableAt = undefined;
      plan.nextAttemptAt = undefined;
    });
    for (let i = plan.installmentsPaid; i < plan.installmentCount; i++) {
      const inst = await st.find("Installment", `${plan.id}-${i}`);
      if (inst && inst.status === "PENDING") inst.status = "WRITTEN_OFF";
    }
    const buyer = await st.buyer(borrower);
    buyer.liquidations += 1;
    (await st.merchant(plan.merchant_id)).liquidatedPlanCount += 1;
    const p = await st.protocol();
    p.liquidationCount += 1;
    p.lossVolume += outstanding - recovered;
    (await st.protocolDay()).liquidations += 1;
    st.activity("plan.liquidated", plan.merchant_id, {
      buyer: borrower,
      orderId: plan.orderId,
      orderKey: plan.orderKey,
      refId: plan.id,
      amount: outstanding,
      recovered,
      reason: recovered >= outstanding ? "recovered in full" : `recovered ${recovered} of ${outstanding}`,
    });
  }),
);

/* ── Settings and roles ─────────────────────────────────────────────────── */

indexer.onEvent({ contract: "PolarisLoanEngine", event: "OriginatorSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisLoanEngine", "OriginatorSet", { subject: event.params.originator, granted: event.params.allowed });
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "CollateralVaultSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisLoanEngine", "CollateralVaultSet", { subject: event.params.vault });
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "MerchantRegistrySet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisLoanEngine", "MerchantRegistrySet", { subject: event.params.registry });
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "TreasuryChanged" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisLoanEngine", "TreasuryChanged", { subject: event.params.treasury });
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "LiquidityWithdrawn" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisLoanEngine", "LiquidityWithdrawn", { subject: event.params.to, value: event.params.amount.toString() });
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "NonceInvalidated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisLoanEngine", "NonceInvalidated", { subject: event.params.borrower, value: event.params.nonce.toString() });
  }),
);

indexer.onEvent({ contract: "PolarisLoanEngine", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "PolarisLoanEngine", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);
