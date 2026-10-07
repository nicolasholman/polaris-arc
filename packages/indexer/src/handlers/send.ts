/**
 * Send by link: money escrowed as a link, and what became of each link.
 *
 * Two instances of the same contract: PolarisSend holds USDC (dollars),
 * PolarisSendEURC holds EURC (euros). A Send row says which (`currency`), and
 * every total keeps the two apart: the plain fields count dollars, the
 * `eurc*` fields euros, never summed together.
 */

import { indexer } from "envio";

import { withStore, type Store } from "../lib/store.js";
import { toInt } from "../lib/util.js";

const SENDS = [
  { contract: "PolarisSend", currency: "USD" },
  { contract: "PolarisSendEURC", currency: "EUR" },
] as const;

type Currency = (typeof SENDS)[number]["currency"];

async function countSent(st: Store, currency: Currency, sender: string, amount: bigint): Promise<void> {
  const account = await st.buyer(sender);
  const p = await st.protocol();
  const pd = await st.protocolDay();
  if (currency === "EUR") {
    account.eurcSentCount += 1;
    account.eurcSentVolume += amount;
    p.eurcSendCount += 1;
    p.eurcSendVolume += amount;
    pd.eurcSendCount += 1;
    pd.eurcSendVolume += amount;
    return;
  }
  account.sentCount += 1;
  account.sentVolume += amount;
  p.sendCount += 1;
  p.sendVolume += amount;
  pd.sendCount += 1;
  pd.sendVolume += amount;
}

async function countClaimed(st: Store, currency: Currency, to: string, amount: bigint): Promise<void> {
  const account = await st.buyer(to);
  const p = await st.protocol();
  const pd = await st.protocolDay();
  if (currency === "EUR") {
    account.eurcClaimedCount += 1;
    account.eurcClaimedVolume += amount;
    p.eurcClaimCount += 1;
    p.eurcClaimVolume += amount;
    pd.eurcClaimCount += 1;
    return;
  }
  account.claimedCount += 1;
  account.claimedVolume += amount;
  p.claimCount += 1;
  p.claimVolume += amount;
  pd.claimCount += 1;
}

for (const { contract, currency } of SENDS) {
  indexer.onEvent({ contract, event: "Sent" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      const { linkKey, sender, amount, expiresAt } = event.params;
      st.keep("Send", {
        id: linkKey,
        currency,
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
      await countSent(st, currency, sender, amount);
    }),
  );

  indexer.onEvent({ contract, event: "Claimed" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      const { linkKey, to, amount } = event.params;
      const send = await st.find("Send", linkKey);
      if (send) {
        send.status = "CLAIMED";
        send.recipient = to;
        send.closedAt = st.m.timestamp;
        send.closedTxHash = st.m.txHash;
      }
      await countClaimed(st, currency, to, amount);
    }),
  );

  indexer.onEvent({ contract, event: "Cancelled" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      const send = await st.find("Send", event.params.linkKey);
      if (!send) return;
      send.status = "CANCELLED";
      send.closedAt = st.m.timestamp;
      send.closedTxHash = st.m.txHash;
    }),
  );

  indexer.onEvent({ contract, event: "Refunded" }, async ({ event, context }) =>
    withStore(context, event, async (st) => {
      const send = await st.find("Send", event.params.linkKey);
      if (!send) return;
      send.status = "REFUNDED";
      send.closedAt = st.m.timestamp;
      send.closedTxHash = st.m.txHash;
    }),
  );
}
