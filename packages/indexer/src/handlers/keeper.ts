/**
 * The Polaris keeper's receivers: who may submit reports, and who owns them.
 *
 * CollectionsReceiver and UnderwritingReceiver each accept reports from one
 * keeper EOA (`submitReport(bytes)`); KeeperSet records every change of that
 * key. The reports themselves are indexed by what they did:
 * src/handlers/collections.ts (tasks executed or skipped) and
 * src/handlers/credit.ts (underwriting applied or refused).
 */

import { indexer } from "envio";

import { configChange } from "../lib/config.js";
import { withStore } from "../lib/store.js";

for (const contract of ["CollectionsReceiver", "UnderwritingReceiver"] as const) {
  indexer.onEvent({ contract, event: "KeeperSet" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "KeeperSet", { subject: event.params.keeper, value: event.params.previousKeeper });
    }),
  );
  indexer.onEvent({ contract, event: "OwnershipTransferred" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      configChange(st, contract, "OwnershipTransferred", { subject: event.params.newOwner, value: event.params.previousOwner });
    }),
  );
}
