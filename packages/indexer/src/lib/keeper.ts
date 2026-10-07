/**
 * The Polaris keeper's reports. The keeper (services/keeper) is one EOA that
 * calls `submitReport(bytes)` on the CollectionsReceiver and the
 * UnderwritingReceiver itself, so a report is its transaction: one
 * KeeperReport row per (transaction, receiver), counted once. A report the
 * receiver refuses reverts and leaves nothing to index.
 */

import type { Store } from "./store.js";

export type KeeperReportKind = "collections" | "underwriting";

/**
 * The report this log belongs to, created on its first log. `items` adds to
 * the report's item count (an underwriting report has one event per item; a
 * collections report says its task count once, in CollectionsRun).
 */
export async function keeperReport(st: Store, kind: KeeperReportKind, items: number): Promise<void> {
  const id = `${st.m.txHash}-${kind}`;
  const { row, created } = await st.upsert("KeeperReport", id, () => ({
    id,
    kind,
    receiver: st.m.srcAddress,
    keeper: st.m.from,
    items: 0,
    timestamp: st.m.timestamp,
    blockNumber: st.m.blockNumber,
    txHash: st.m.txHash,
  }));
  row.items += items;
  if (!created) return;
  (await st.protocol()).keeperReports += 1;
  (await st.protocolDay()).keeperReports += 1;
}
