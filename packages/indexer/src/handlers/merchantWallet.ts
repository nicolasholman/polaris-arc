/**
 * Merchant accounts: the stablecoin moving in and out of them.
 *
 * A merchant's account is registered at runtime as a `MerchantWallet` when,
 * and only when, it registers with the MerchantRegistry. The Transfer handler
 * runs in wildcard mode, filtered at the source (HyperSync topics) to
 * transfers from or to those accounts, and keeps only the stablecoin's.
 *
 * Why only MerchantRegistered. Envio runs `contractRegister` as each
 * contract's query answers, and those answers arrive in any order. When one
 * account was registered from several events (the registry, a payment, a
 * loan), whichever answer came first fixed where its transfers start: a loan
 * at block 35 seen before the registration at block 23 dropped the first
 * payment, at block 34, from the balance (the flaky live test). One event per
 * account can't race itself. It also means nobody can make the indexer follow
 * an arbitrary account (an exchange's hot wallet) by paying it a cent.
 *
 * So `Merchant.balance` counts every stablecoin transfer from the block the
 * merchant registered (`registeredAt`), which for a Polaris business is
 * before any money. An account paid without ever registering is not
 * followed: its `registeredAt` is null and its balance stays 0 (read
 * AUSD.balanceOf); its payments still count in every volume.
 *
 * Payouts: a transfer out of a merchant account in a transaction sent to the
 * stablecoin itself (the relayer carrying the merchant's signed
 * transferWithAuthorization) is a payout. Money leaving through a Polaris
 * contract (a checkout payment, a send) is not.
 */

import { indexer } from "envio";

import { balanceTick, withStore, type Merchant, type Store } from "../lib/store.js";
import { logId } from "../lib/util.js";

/* ── Which accounts are merchants ───────────────────────────────────────── */

indexer.contractRegister({ contract: "MerchantRegistry", event: "MerchantRegistered" }, async ({ event, context }) => {
  context.chain.MerchantWallet.add(event.params.merchant);
});

/** The merchant row for a followed account: registered before this log. */
async function followed(st: Store, address: string): Promise<Merchant | undefined> {
  const m = await st.find("Merchant", address);
  return m?.registered ? m : undefined;
}

/* ── Money in and out ───────────────────────────────────────────────────── */

indexer.onEvent(
  {
    contract: "MerchantWallet",
    event: "Transfer",
    wildcard: true,
    where: ({ chain }) => ({
      params: [{ from: chain.MerchantWallet.addresses }, { to: chain.MerchantWallet.addresses }],
    }),
  },
  async ({ event, context }) =>
    withStore(context, event, async (st) => {
      const { addresses } = st.settings;
      // Wildcard: any token's Transfer between these accounts arrives; only the stablecoin's counts.
      if (st.m.srcAddress !== addresses.Stablecoin) return;
      const { from, to, value } = event.params;
      if (from === to || value === 0n) return;

      const polaris = new Set<string>(
        Object.entries(addresses)
          .filter(([name]) => name !== "Stablecoin")
          .map(([, address]) => address),
      );

      // The source fetches a registered account's transfers from the block it
      // registered; one earlier in that block (or one the source over-fetched)
      // is not the merchant's yet.
      const payee = await followed(st, to);
      const payer = await followed(st, from);

      if (payee) {
        const day = await st.merchantDay(payee);
        payee.balance += value;
        payee.updatedAt = st.m.timestamp;
        balanceTick(day, payee.balance);
      }

      if (payer) {
        const day = await st.merchantDay(payer);
        payer.balance -= value;
        payer.updatedAt = st.m.timestamp;
        balanceTick(day, payer.balance);

        const direct = st.m.to === addresses.Stablecoin;
        if (direct && !polaris.has(to)) {
          const id = logId(st.m.txHash, st.m.logIndex);
          st.keep("Payout", {
            id,
            merchant_id: payer.id,
            amount: value,
            destination: to,
            toPayoutAddress: payer.payoutAddress === to,
            relayer: st.m.from,
            day: st.m.day,
            timestamp: st.m.timestamp,
            blockNumber: st.m.blockNumber,
            txHash: st.m.txHash,
          });
          payer.payoutCount += 1;
          payer.payoutVolume += value;
          day.payoutCount += 1;
          day.payoutVolume += value;
          const p = await st.protocol();
          p.payoutCount += 1;
          p.payoutVolume += value;
          const pd = await st.protocolDay();
          pd.payoutCount += 1;
          pd.payoutVolume += value;
          st.activity("payout.paid", payer.id, { refId: id, amount: value, destination: to });
        }
      }
    }),
);
