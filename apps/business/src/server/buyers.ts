import "server-only";

import type { MerchantRecord } from "@polaris/db";
import type { Address } from "viem";

import { getDb } from "./db";
import { receiptIndex } from "./receipts";
import { splitsOrganisedBy } from "./split";
import { walletMoves } from "./wallet-moves";

/**
 * A buyer's book as the Polaris app shows it: their Pay in 4 plans, their
 * subscriptions and their payments to Polaris merchants, from the records
 * the chain sync keeps (every one of them came from a chain event), and
 * every other dollar in or out of the address (`moves`: money added,
 * transfers, send links made, claimed or taken back, instalments), read
 * from the chain's AUSD and PolarisSend logs (wallet-moves.ts).
 *
 * Public by address, so only what the chain already shows: amounts,
 * schedules, the merchant's name and address, transaction hashes. Never a
 * checkout's description, order id or metadata, which are the merchant's
 * and the buyer's business, not an address-holder's.
 */

const LIMIT = 100;

function merchantView(m: MerchantRecord | undefined, fallback: string) {
  return { id: m?.publicId ?? null, name: m?.businessName ?? "Polaris merchant", address: (m?.walletAddress ?? fallback) as Address };
}

export async function buyerBook(address: Address) {
  const db = getDb();
  const who = address.toLowerCase();
  const [plans, subscriptions, payments, moves, splits, sealed] = await Promise.all([
    db.plans.find({ borrower: who }, { orderBy: "createdAt", direction: "desc", limit: LIMIT }),
    db.subscriptions.find({ subscriber: who }, { orderBy: "createdAt", direction: "desc", limit: LIMIT }),
    db.payments.find({ payer: who }, { orderBy: "createdAt", direction: "desc", limit: LIMIT }),
    walletMoves(address),
    splitsOrganisedBy(address),
    receiptIndex(address),
  ]);
  const ids = [...new Set([...plans, ...subscriptions, ...payments].map((r) => r.merchantId))];
  const merchants = new Map((await Promise.all(ids.map((id) => db.merchants.get(id)))).filter((m): m is MerchantRecord => m !== null).map((m) => [m.id, m]));
  const merchantOf = (id: string) => merchantView(merchants.get(id), "0x0000000000000000000000000000000000000000");

  return {
    address,
    plans: plans
      .map((p) => ({
        id: p.id,
        merchant: merchantOf(p.merchantId),
        principalUnits: p.principalUnits,
        totalOwedUnits: p.totalOwedUnits,
        repaidUnits: p.repaidUnits,
        installments: p.installments,
        installmentsPaid: p.installmentsPaid,
        intervalSeconds: p.intervalSeconds,
        /** Unix seconds; instalment i (0-based) is due at startedAt + (i+1)·interval. */
        startedAt: p.startedAt,
        state: p.state,
        openedTxHash: p.openedTxHash,
        createdAt: p.createdAt,
        /** Why the current instalment wasn't collected (insufficient_funds, allowance_lost, other), and when it is tried again. */
        lastFailure: p.lastFailure,
        /**
         * The loan engine's approval is gone: the buyer signs once more
         * (`POST /api/relay` type "reauthorize") and the CRE collections run
         * that follows collects the instalment.
         */
        needsSignature: p.state === "dunning" && p.lastFailure?.reason === "allowance_lost" && !p.reauthorized,
        /** They signed again (the Reauthorized transaction), and the collection that followed, once it lands. */
        reauthorized: p.reauthorized ?? null,
      })),
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      planId: s.planId,
      merchant: merchantOf(s.merchantId),
      priceUnits: s.priceUnits,
      periodSeconds: s.periodSeconds,
      periodsCharged: s.periodsCharged,
      nextChargeAt: s.nextChargeAt,
      status: s.status,
      createdAt: s.createdAt,
    })),
    payments: payments
      .filter((p) => !p.mismatch)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        merchant: merchantOf(p.merchantId),
        amountUnits: p.amountUnits,
        txHash: p.txHash,
        createdAt: p.createdAt,
      })),
    /** Every AUSD transfer to or from the address, classified; `payment` rows are the transfers inside a payment above. */
    moves: moves.map((m) => ({
      id: m.id,
      kind: m.kind,
      direction: m.direction,
      amountUnits: m.amountUnits,
      counterparty: m.counterparty,
      txHash: m.txHash,
      linkKey: m.linkKey,
      settledAs: m.settledAs,
      settledAt: m.settledAt,
      /** split-paid and split-received: the split and the share. */
      splitId: m.splitId ?? null,
      shareIndex: m.shareIndex ?? null,
      at: m.at,
    })),
    /**
     * The split-the-bill links this address organised (PolarisSplit), newest
     * first: each share's amount, who paid it and when, and the status. Never
     * the split's words, which travel in the link.
     */
    splits,
    /**
     * Whether this address registered a receipts inbox, and which rows have a
     * sealed receipt (by transaction): never what is in one. The ciphertext
     * itself comes only from `POST /api/receipts`, with the account's signature.
     */
    receiptsInbox: sealed.inbox,
    receipts: sealed.receipts,
  };
}
