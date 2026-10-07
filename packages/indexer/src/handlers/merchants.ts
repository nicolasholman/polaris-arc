/**
 * MerchantRegistry (onboarding, activation, caps, payout address) and
 * BatchSettlement (batch payouts with memos).
 */

import { indexer } from "envio";

import { configChange } from "../lib/config.js";
import { withStore } from "../lib/store.js";
import { logId } from "../lib/util.js";

/** MerchantRegistry.DEFAULT_MAX_ORDER_VALUE: a new merchant's Pay in 4 cap ($500). */
const DEFAULT_MAX_ORDER_VALUE = 500_000_000n;

indexer.onEvent({ contract: "MerchantRegistry", event: "MerchantRegistered" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { merchant, name, payoutAddress } = event.params;
    const m = await st.merchant(merchant);
    if (!m.registered) (await st.protocol()).registeredMerchantCount += 1;
    m.registered = true;
    m.name = name;
    m.payoutAddress = payoutAddress;
    m.registeredAt = st.m.timestamp;
    m.maxOrderValue = DEFAULT_MAX_ORDER_VALUE;
  }),
);

indexer.onEvent({ contract: "MerchantRegistry", event: "MerchantRegisteredBy" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.merchant(event.params.merchant)).registeredBy = event.params.operator;
  }),
);

indexer.onEvent({ contract: "MerchantRegistry", event: "MerchantActivated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.merchant(event.params.merchant)).active = event.params.active;
  }),
);

indexer.onEvent({ contract: "MerchantRegistry", event: "MerchantUpdated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const m = await st.merchant(event.params.merchant);
    m.payoutAddress = event.params.payoutAddress;
    m.maxOrderValue = event.params.maxOrderValue;
  }),
);

indexer.onEvent({ contract: "MerchantRegistry", event: "SettlementRecorded" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.merchant(event.params.merchant)).settlementRecorded += event.params.amount;
  }),
);

indexer.onEvent({ contract: "MerchantRegistry", event: "OperatorSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "MerchantRegistry", "OperatorSet", { subject: event.params.operator, granted: event.params.allowed });
  }),
);

indexer.onEvent({ contract: "MerchantRegistry", event: "NonceInvalidated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "MerchantRegistry", "NonceInvalidated", { subject: event.params.merchant, value: event.params.nonce.toString() });
  }),
);

indexer.onEvent({ contract: "MerchantRegistry", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "MerchantRegistry", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);

/* ── BatchSettlement ────────────────────────────────────────────────────── */

indexer.onEvent({ contract: "BatchSettlement", event: "Funded" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    st.keep("BatchLeg", {
      id: logId(st.m.txHash, st.m.logIndex),
      kind: "FUNDED",
      batch_id: undefined,
      account: event.params.from,
      amount: event.params.amount,
      memo: undefined,
      timestamp: st.m.timestamp,
      blockNumber: st.m.blockNumber,
      txHash: st.m.txHash,
    });
  }),
);

// The legs come first (MerchantPaid per recipient), then BatchSettled.
indexer.onEvent({ contract: "BatchSettlement", event: "MerchantPaid" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    st.keep("BatchLeg", {
      id: logId(st.m.txHash, st.m.logIndex),
      kind: "PAID",
      batch_id: event.params.batchId,
      account: event.params.merchant,
      amount: event.params.amount,
      memo: event.params.memo,
      timestamp: st.m.timestamp,
      blockNumber: st.m.blockNumber,
      txHash: st.m.txHash,
    });
  }),
);

indexer.onEvent({ contract: "BatchSettlement", event: "BatchSettled" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { batchId, recipients, totalAmount, settler } = event.params;
    st.keep("Batch", {
      id: batchId,
      recipients: Number(recipients),
      totalAmount,
      settler,
      timestamp: st.m.timestamp,
      txHash: st.m.txHash,
    });
  }),
);

indexer.onEvent({ contract: "BatchSettlement", event: "SettlerSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "BatchSettlement", "SettlerSet", { subject: event.params.settler, granted: event.params.allowed });
  }),
);

indexer.onEvent({ contract: "BatchSettlement", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "BatchSettlement", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);
