/**
 * PolarisSend: dollars sent as a link, and what became of each link.
 */

import { indexer } from "envio";

import { withStore } from "../lib/store.js";
import { toInt } from "../lib/util.js";

indexer.onEvent({ contract: "PolarisSend", event: "Sent" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { linkKey, sender, amount, expiresAt } = event.params;
    st.keep("Send", {
      id: linkKey,
      sender,
      amount,
      expiresAt: toInt(expiresAt),
      status: "OPEN",
      recipient: undefined,
      sentAt: st.m.timestamp,
      closedAt: undefined,
      sentTxHash: st.m.txHash,
      closedTxHash: undefined,
      relayer: st.m.from,
    });
    const account = await st.buyer(sender);
    account.sentCount += 1;
    account.sentVolume += amount;
    const p = await st.protocol();
    p.sendCount += 1;
    p.sendVolume += amount;
    const pd = await st.protocolDay();
    pd.sendCount += 1;
    pd.sendVolume += amount;
  }),
);

indexer.onEvent({ contract: "PolarisSend", event: "Claimed" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const { linkKey, to, amount } = event.params;
    const send = await st.find("Send", linkKey);
    if (send) {
      send.status = "CLAIMED";
      send.recipient = to;
      send.closedAt = st.m.timestamp;
      send.closedTxHash = st.m.txHash;
    }
    const account = await st.buyer(to);
    account.claimedCount += 1;
    account.claimedVolume += amount;
    const p = await st.protocol();
    p.claimCount += 1;
    p.claimVolume += amount;
    (await st.protocolDay()).claimCount += 1;
  }),
);

indexer.onEvent({ contract: "PolarisSend", event: "Cancelled" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const send = await st.find("Send", event.params.linkKey);
    if (!send) return;
    send.status = "CANCELLED";
    send.closedAt = st.m.timestamp;
    send.closedTxHash = st.m.txHash;
  }),
);

indexer.onEvent({ contract: "PolarisSend", event: "Refunded" }, async ({ event, context }) =>
  withStore(context, event, async (st) => {
    const send = await st.find("Send", event.params.linkKey);
    if (!send) return;
    send.status = "REFUNDED";
    send.closedAt = st.m.timestamp;
    send.closedTxHash = st.m.txHash;
  }),
);
