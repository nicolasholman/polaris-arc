/**
 * The credit guard (CreditGuard): its thresholds, the owner's override and
 * the bad debt the owner acknowledged. CreditGuard reads the pool live, so
 * whether Pay in 4 is paused right now is a view (creditStatus()), not an
 * event: the CreditGuard row holds the settings that decide it, and every
 * change is also a ConfigChange row.
 */

import { indexer } from "envio";

import { configChange } from "../lib/config.js";
import { withStore, type Store } from "../lib/store.js";
import { toInt } from "../lib/util.js";

export const CREDIT_GUARD_ID = "credit-guard";

/** CreditGuard.Override. */
const OVERRIDE = ["NONE", "FORCE_RESUME", "FORCE_PAUSE"] as const;

async function guardRow(st: Store) {
  const { row } = await st.upsert("CreditGuard", CREDIT_GUARD_ID, () => ({
    id: CREDIT_GUARD_ID,
    address: st.m.srcAddress,
    minFreeCash: undefined,
    maxBadDebtBps: undefined,
    minOriginated: undefined,
    overrideMode: "NONE",
    overrideUntil: undefined,
    badDebtAcknowledged: 0n,
    updatedAt: st.m.timestamp,
    updatedTxHash: st.m.txHash,
  }));
  row.address = st.m.srcAddress;
  row.updatedAt = st.m.timestamp;
  row.updatedTxHash = st.m.txHash;
  return row;
}

indexer.onEvent({ contract: "CreditGuard", event: "ThresholdsSet" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    // A Solidity struct arrives as a tuple: (minFreeCash, maxBadDebtBps, minOriginated).
    const t = event.params.thresholds;
    const minFreeCash = t[0];
    const maxBadDebtBps = t[1];
    const minOriginated = t[2];
    const row = await guardRow(st);
    row.minFreeCash = minFreeCash;
    row.maxBadDebtBps = toInt(maxBadDebtBps);
    row.minOriginated = minOriginated;
    configChange(st, "CreditGuard", "ThresholdsSet", {
      value: `minFreeCash=${minFreeCash} maxBadDebtBps=${maxBadDebtBps} minOriginated=${minOriginated}`,
    });
  }),
);

indexer.onEvent({ contract: "CreditGuard", event: "CreditGuardOverridden" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const mode = OVERRIDE[toInt(event.params.mode)] ?? "NONE";
    const until = toInt(event.params.until);
    const row = await guardRow(st);
    row.overrideMode = mode;
    row.overrideUntil = until === 0 ? undefined : until;
    configChange(st, "CreditGuard", "CreditGuardOverridden", { value: until === 0 ? mode : `${mode} until ${until}` });
  }),
);

indexer.onEvent({ contract: "CreditGuard", event: "BadDebtAcknowledged" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const row = await guardRow(st);
    row.badDebtAcknowledged = event.params.badDebt;
    configChange(st, "CreditGuard", "BadDebtAcknowledged", { value: event.params.badDebt.toString() });
  }),
);

indexer.onEvent({ contract: "CreditGuard", event: "OwnershipTransferred" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    configChange(st, "CreditGuard", "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
  }),
);
