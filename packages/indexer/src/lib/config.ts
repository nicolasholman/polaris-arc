/** ConfigChange rows: roles, settings and nonce cancellations on Polaris contracts. */

import { logId } from "./util.js";
import type { Store } from "./store.js";

export function configChange(
  st: Store,
  contract: string,
  event: string,
  fields: { subject?: string; granted?: boolean; value?: string },
): void {
  st.keep("ConfigChange", {
    id: logId(st.m.txHash, st.m.logIndex),
    contract,
    event,
    subject: fields.subject?.toLowerCase(),
    granted: fields.granted,
    value: fields.value,
    timestamp: st.m.timestamp,
    blockNumber: st.m.blockNumber,
    txHash: st.m.txHash,
  });
}
