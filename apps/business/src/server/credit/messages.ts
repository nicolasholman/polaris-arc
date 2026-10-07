import type { Address } from "viem";

/**
 * The two texts a buyer signs to be underwritten, byte-for-byte as the
 * keeper checks them (services/keeper/src/underwriting.ts):
 *
 * - the account's consent (`underwriteConsentMessage`):
 *   the account itself asks to be underwritten, once, with exactly this
 *   history wallet (or none), on this chain;
 * - the history wallet's link proof (`linkMessage`, in
 *   packages/underwriting/src/core/link.ts): the wallet agrees to count
 *   toward this account.
 *
 * test/credit.test.ts pins both texts, and the keeper's tests pin its copy
 * of the consent, so a change on either side fails a test.
 *
 * Both are EIP-191 personal messages, good for 15 minutes
 * (ScoreManager.MAX_EVIDENCE_AGE).
 */

/** How old a consent or link proof may be, in seconds. */
export const EVIDENCE_MAX_AGE_SECONDS = 15 * 60;

const NONCE = /^[A-Za-z0-9_-]{8,64}$/;

function isoSeconds(issuedAt: number): string {
  return new Date(Math.floor(issuedAt) * 1000).toISOString().replace(".000Z", "Z");
}

export function underwriteConsentMessage(p: { account: Address; wallet: Address | null; chainId: number; issuedAt: number; nonce: string }): string {
  if (!NONCE.test(p.nonce)) throw new RangeError("nonce must be 8-64 url-safe characters");
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) throw new RangeError("chainId must be a positive integer");
  if (!Number.isFinite(p.issuedAt)) throw new RangeError("issuedAt must be unix seconds");
  return [
    "Polaris: underwrite this account for Pay in 4 credit, once, from the evidence below.",
    "",
    `Account: ${p.account.toLowerCase()}`,
    `History wallet: ${p.wallet ? p.wallet.toLowerCase() : "none"}`,
    `Chain: ${p.chainId}`,
    `Issued: ${isoSeconds(p.issuedAt)}`,
    `Nonce: ${p.nonce}`,
  ].join("\n");
}

export function linkMessage(p: { account: Address; wallet: Address; issuedAt: number; nonce: string }): string {
  if (!NONCE.test(p.nonce)) throw new RangeError("nonce must be 8-64 url-safe characters");
  return [
    "Polaris: count this wallet's history toward my credit line.",
    "",
    `Account: ${p.account.toLowerCase()}`,
    `Wallet: ${p.wallet.toLowerCase()}`,
    `Issued: ${isoSeconds(p.issuedAt)}`,
    `Nonce: ${p.nonce}`,
  ].join("\n");
}

/** Null when fresh, else why not (the keeper applies the same rule). */
export function evidenceStaleness(issuedAt: number, nowSeconds: number): string | null {
  if (!Number.isFinite(issuedAt)) return "unreadable issue time";
  if (issuedAt > nowSeconds + 60) return "issued in the future";
  if (nowSeconds - issuedAt > EVIDENCE_MAX_AGE_SECONDS) return "older than 15 minutes";
  return null;
}
