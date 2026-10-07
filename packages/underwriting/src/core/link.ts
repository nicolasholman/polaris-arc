/**
 * "Bring your history" (plan §5.5): the buyer proves they own a wallet they
 * already use by signing one message with it, over WalletConnect.
 *
 * Without this, anyone could claim a famous wallet's history and open a
 * $1,000 line on it. The message names both accounts, so a signature for one
 * Polaris account cannot be replayed for another, and carries its issue time,
 * so an old one cannot be reused later. It is an EIP-191 personal message;
 * the Node service checks it with viem's `verifyMessage`, and the CRE workflow
 * can do the same. This module only builds and dates the text, so it stays
 * dependency-free.
 *
 * One linked wallet should back one Polaris account. That is enforced where
 * links are stored (the app's API and, on chain, the underwriting receiver),
 * not here.
 */

import type { Address } from "./types.ts";

/** How old a link proof may be, in seconds. Matches ScoreManager.MAX_EVIDENCE_AGE. */
export const LINK_PROOF_MAX_AGE = 15 * 60;

export interface LinkProof {
  /** The buyer's Polaris account. */
  account: Address;
  /** The wallet whose history they bring. */
  wallet: Address;
  /** Unix seconds when the app asked for the signature. */
  issuedAt: number;
  /** Random, from the app, so two proofs are never the same text. */
  nonce: string;
  /** The wallet's EIP-191 signature over `linkMessage(...)`. */
  signature: `0x${string}`;
}

/** The exact text the wallet signs. */
export function linkMessage(p: Pick<LinkProof, "account" | "wallet" | "issuedAt" | "nonce">): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.nonce)) throw new RangeError("nonce must be 8-64 url-safe characters");
  const issued = new Date(Math.floor(p.issuedAt) * 1000).toISOString().replace(".000Z", "Z");
  return [
    "Polaris: count this wallet's history toward my credit line.",
    "",
    `Account: ${p.account.toLowerCase()}`,
    `Wallet: ${p.wallet.toLowerCase()}`,
    `Issued: ${issued}`,
    `Nonce: ${p.nonce}`,
  ].join("\n");
}

/** Null when fresh, else why not. */
export function linkProofStaleness(issuedAt: number, now: number): string | null {
  if (!Number.isFinite(issuedAt)) return "unreadable issue time";
  if (issuedAt > now + 60) return "issued in the future";
  if (now - issuedAt > LINK_PROOF_MAX_AGE) return "older than 15 minutes";
  return null;
}
