/**
 * The two texts a buyer's account signs (EIP-191 personal messages) for its
 * receipts. A Face ID ceremony proves nothing to a server by itself; a
 * signature from the key that Face ID derived does (docs/research/mera.md §8).
 * Both are signed with the session that is already open: no extra prompt.
 *
 * The app signs them and the API checks them, from this one copy.
 */

/** Register (or re-register) the inbox key receipts are sealed to. The signature recovers the account. */
export const inboxRegistrationMessage = (inboxPublicKey: string): string => `Polaris receipts key ${inboxPublicKey.toLowerCase()}`;

/** How old a read request may be, in seconds. */
export const RECEIPTS_READ_MAX_AGE_SECONDS = 5 * 60;

function isoSeconds(issuedAt: number): string {
  return new Date(Math.floor(issuedAt) * 1000).toISOString().replace(".000Z", "Z");
}

/** Ask for this account's sealed receipts. Good for five minutes. */
export function receiptsReadMessage(account: string, issuedAt: number): string {
  if (!Number.isFinite(issuedAt)) throw new RangeError("issuedAt must be unix seconds");
  return ["Polaris: show me my sealed receipts.", "", `Account: ${account.toLowerCase()}`, `Issued: ${isoSeconds(issuedAt)}`].join("\n");
}

/** Null when a read request issued at `issuedAt` is fresh, else why not. */
export function readRequestStaleness(issuedAt: number, nowSeconds: number): string | null {
  if (!Number.isSafeInteger(issuedAt)) return "unreadable issue time";
  if (issuedAt > nowSeconds + 60) return "issued in the future";
  if (nowSeconds - issuedAt > RECEIPTS_READ_MAX_AGE_SECONDS) return "older than 5 minutes";
  return null;
}
