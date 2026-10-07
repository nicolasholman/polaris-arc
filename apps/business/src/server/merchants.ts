import "server-only";

import { isDuplicateKeyError, newMerchantRecord, type MerchantRecord } from "@polaris/db";

import type { Merchant } from "@/lib/data/types";
import type { AuthedMerchant } from "./auth";
import { getDb } from "./db";

/**
 * Merchants: created on first sight of a verified Privy session, keyed by the
 * Privy user id. Privy stays the source of truth for the wallet and email.
 * Everything a merchant's dashboard shows comes from the chain; with no chain
 * configured, the book is empty and the dashboard says why.
 */

export async function ensureMerchant(auth: AuthedMerchant): Promise<MerchantRecord> {
  const db = getDb();
  const existing = await db.merchants.get(auth.userId);
  if (existing) {
    // A record from an older build that seeded an invented book when no chain
    // was configured: clear the flag and the withdrawals recorded against it.
    const legacy = existing.sample;
    const changed =
      (auth.walletAddress && existing.walletAddress !== auth.walletAddress) ||
      (auth.walletId && existing.walletId !== auth.walletId) ||
      (auth.email && existing.email !== auth.email);
    if (!changed && !legacy) return existing;
    const updated = (await db.merchants.update(auth.userId, (m) => ({
      ...m,
      walletAddress: auth.walletAddress ?? m.walletAddress,
      walletId: auth.walletId ?? m.walletId,
      email: auth.email ?? m.email,
      ...(legacy ? { sample: false, sampleBalanceCents: 0 } : {}),
    }))) as MerchantRecord;
    if (legacy) await dropLegacyPayouts(auth.userId);
    return updated;
  }
  const record = newMerchantRecord({
    id: auth.userId,
    walletAddress: auth.walletAddress,
    walletId: auth.walletId,
    email: auth.email,
  });
  try {
    return await db.merchants.insert(record);
  } catch (error) {
    // Two first requests raced; the other one created it.
    if (isDuplicateKeyError(error)) return (await db.merchants.get(auth.userId)) as MerchantRecord;
    throw error;
  }
}

/** Withdrawals an older build recorded against an invented balance: never real, so never shown. */
async function dropLegacyPayouts(merchantId: string): Promise<void> {
  const db = getDb();
  const rows = await db.payouts.find({ merchantId }, { limit: 10_000 });
  for (const p of rows) if (p.sample) await db.payouts.delete(p.id);
}

export async function merchantByWallet(address: string): Promise<MerchantRecord | null> {
  return getDb().merchants.findOne({ wallet: address.toLowerCase() });
}

export function toMerchant(m: MerchantRecord): Merchant {
  return {
    id: m.id,
    publicId: m.publicId,
    businessName: m.businessName,
    walletAddress: m.walletAddress,
    email: m.email,
    createdAt: m.createdAt,
    registration: {
      state: m.registration.state,
      txHash: m.registration.txHash,
      activationTxHash: m.registration.activationTxHash,
      error: m.registration.error,
    },
  };
}
