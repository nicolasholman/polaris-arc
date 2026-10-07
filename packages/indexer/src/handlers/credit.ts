/**
 * The buyer's credit line: ScoreManager scores, CRE underwriting (the
 * UnderwritingReceiver), and collateral in the CollateralVault.
 *
 * Inside one underwriting report, per item: ScoreManager.Underwritten, then
 * ScoreChanged("underwritten"), then UnderwritingApplied; or only
 * UnderwritingRefused.
 */

import { indexer } from "envio";

import { configChange } from "../lib/config.js";
import { decodeRevert } from "../lib/revert.js";
import { scoreTick, withStore, type Store } from "../lib/store.js";
import { logId, toInt, ZERO_ADDRESS } from "../lib/util.js";

async function underwritingRow(st: Store, user: string) {
  const buyer = await st.buyer(user);
  const { row } = await st.upsert("Underwriting", `${st.m.txHash}-${buyer.id}`, () => ({
    id: `${st.m.txHash}-${buyer.id}`,
    buyer_id: buyer.id,
    linkedWallet: undefined,
    applied: false,
    score: undefined,
    declined: undefined,
    observedAt: undefined,
    refusal: undefined,
    refusalData: undefined,
    timestamp: st.m.timestamp,
    blockNumber: st.m.blockNumber,
    txHash: st.m.txHash,
  }));
  return { buyer, row };
}

/* ── ScoreManager ───────────────────────────────────────────────────────── */

indexer.onEvent({ contract: "ScoreManager", event: "ScoreChanged" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { user, oldScore, newScore, reason } = event.params;
    const buyer = await st.buyer(user);
    const day = await st.buyerDay(buyer);
    buyer.score = toInt(newScore);
    buyer.hasRecord = true;
    scoreTick(day, buyer.score);
    await st.refreshCredit(buyer);
    st.keep("ScoreEvent", {
      id: logId(st.m.txHash, st.m.logIndex),
      buyer_id: buyer.id,
      oldScore: toInt(oldScore),
      newScore: toInt(newScore),
      delta: toInt(newScore) - toInt(oldScore),
      reason,
      timestamp: st.m.timestamp,
      blockNumber: st.m.blockNumber,
      txHash: st.m.txHash,
    });
  }),
);

indexer.onEvent({ contract: "ScoreManager", event: "Underwritten" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { user, score, declined, observedAt } = event.params;
    const { buyer, row } = await underwritingRow(st, user);
    buyer.underwritten = true;
    buyer.hasRecord = true;
    buyer.declined = declined;
    buyer.underwrittenAt = st.m.timestamp;
    buyer.lastUnderwritingRefusal = undefined;
    await st.refreshCredit(buyer);
    row.applied = true;
    row.score = toInt(score);
    row.declined = declined;
    row.observedAt = toInt(observedAt);
  }),
);

indexer.onEvent({ contract: "ScoreManager", event: "DeclinedForDefaults" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const buyer = await st.buyer(event.params.user);
    buyer.declined = true;
    await st.refreshCredit(buyer);
  }),
);

indexer.onEvent({ contract: "ScoreManager", event: "RequireUnderwritingSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.protocol()).requireUnderwriting = event.params.required;
    configChange(st, "ScoreManager", "RequireUnderwritingSet", { value: String(event.params.required) });
  }),
);

indexer.onEvent({ contract: "ScoreManager", event: "CollateralVaultSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.protocol()).collateralCountsTowardLimits = event.params.vault !== ZERO_ADDRESS;
    configChange(st, "ScoreManager", "CollateralVaultSet", { subject: event.params.vault });
  }),
);

indexer.onEvent({ contract: "ScoreManager", event: "WriterSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "ScoreManager", "WriterSet", { subject: event.params.writer, granted: event.params.allowed });
  }),
);

indexer.onEvent({ contract: "ScoreManager", event: "UnderwriterSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "ScoreManager", "UnderwriterSet", { subject: event.params.underwriter, granted: event.params.allowed });
  }),
);

indexer.onEvent({ contract: "ScoreManager", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "ScoreManager", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);

/* ── UnderwritingReceiver (CRE `polaris-underwrite`) ───────────────────── */

indexer.onEvent({ contract: "UnderwritingReceiver", event: "UnderwritingApplied" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { user, linkedWallet, score } = event.params;
    const { buyer, row } = await underwritingRow(st, user);
    row.applied = true;
    row.score = toInt(score);
    if (linkedWallet !== ZERO_ADDRESS) {
      row.linkedWallet = linkedWallet;
      buyer.linkedWallet = linkedWallet;
      st.keep("LinkedWallet", {
        id: linkedWallet,
        buyer_id: buyer.id,
        linkedAt: st.m.timestamp,
        txHash: st.m.txHash,
      });
    }
    (await st.protocol()).underwritings += 1;
  }),
);

indexer.onEvent({ contract: "UnderwritingReceiver", event: "UnderwritingRefused" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { user, linkedWallet, reason } = event.params;
    const { buyer, row } = await underwritingRow(st, user);
    const decoded = decodeRevert(reason);
    row.applied = false;
    row.refusal = decoded.name;
    row.refusalData = reason;
    if (linkedWallet !== ZERO_ADDRESS) row.linkedWallet = linkedWallet;
    buyer.lastUnderwritingRefusal = decoded.name;
  }),
);

indexer.onEvent({ contract: "UnderwritingReceiver", event: "SimulationTransmitterSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "UnderwritingReceiver", "SimulationTransmitterSet", { subject: event.params.transmitter });
  }),
);

/* ── CollateralVault ────────────────────────────────────────────────────── */

indexer.onEvent({ contract: "CollateralVault", event: "CollateralLocked" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const buyer = await st.buyer(event.params.user);
    buyer.collateral = event.params.newTotal;
    await st.refreshCredit(buyer);
  }),
);

indexer.onEvent({ contract: "CollateralVault", event: "CollateralWithdrawn" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const buyer = await st.buyer(event.params.user);
    buyer.collateral = event.params.newTotal;
    await st.refreshCredit(buyer);
  }),
);

indexer.onEvent({ contract: "CollateralVault", event: "CollateralSeized" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const buyer = await st.buyer(event.params.user);
    buyer.collateral = buyer.collateral > event.params.amount ? buyer.collateral - event.params.amount : 0n;
    await st.refreshCredit(buyer);
  }),
);

indexer.onEvent({ contract: "CollateralVault", event: "MultiplierChanged" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    (await st.protocol()).collateralMultiplierBps = toInt(event.params.bps);
    configChange(st, "CollateralVault", "MultiplierChanged", { value: event.params.bps.toString() });
  }),
);

indexer.onEvent({ contract: "CollateralVault", event: "SeizerSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "CollateralVault", "SeizerSet", { subject: event.params.seizer, granted: event.params.allowed });
  }),
);

indexer.onEvent({ contract: "CollateralVault", event: "LoanEngineSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "CollateralVault", "LoanEngineSet", { subject: event.params.engine });
  }),
);

indexer.onEvent({ contract: "CollateralVault", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "CollateralVault", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);

// A borrower retiring an unspent Withdraw (CollateralVault.invalidateNonce). Only a vault with
// withdrawWithSig emits it; Monad testnet's of 28 Sep 2026 never does.
indexer.onEvent({ contract: "CollateralVault", event: "NonceInvalidated" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "CollateralVault", "NonceInvalidated", { subject: event.params.borrower, value: event.params.nonce.toString() });
  }),
);
