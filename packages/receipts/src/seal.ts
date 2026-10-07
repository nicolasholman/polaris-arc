import { buf, fromBase64Url, fromHex, type Hex, toBase64Url } from "./bytes.ts";
import { type ReceiptKeys, suite } from "./keys.ts";
import { parseReceiptBody, type ReceiptBody } from "./receipt.ts";

const te = new TextEncoder();
const td = new TextDecoder();

/** The AAD's version tag. A new receipt format is a new tag. */
export const RECEIPT_AAD_VERSION = "polaris.receipt.v1";

/**
 * Additional authenticated data: binds a ciphertext to its owner and its
 * record id, so the server can neither swap ciphertexts between rows or
 * between buyers nor serve one receipt as another. Opening with any other
 * owner or id fails.
 */
export const receiptAad = (owner: string, id: string): Uint8Array<ArrayBuffer> =>
  te.encode(`${RECEIPT_AAD_VERSION}|${owner.toLowerCase()}|${id}`);

export type Sealed = { enc: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> };

/** Anyone (our API, a CRE path, the buyer's device) seals with the public key alone. No prompt. */
export async function sealToInbox(inboxPublicKey: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Sealed> {
  if (inboxPublicKey.length !== 32) throw new Error("An inbox public key is 32 bytes");
  const recipientPublicKey = await suite.kem.deserializePublicKey(buf(inboxPublicKey));
  const { enc, ct } = await suite.seal({ recipientPublicKey }, buf(plaintext), buf(aad));
  return { enc: new Uint8Array(enc), ct: new Uint8Array(ct) };
}

/** Only the passkey holder opens. Throws on a wrong key, owner or id. */
export async function openFromInbox(keys: Pick<ReceiptKeys, "inbox">, aad: Uint8Array, sealed: { enc: Uint8Array; ct: Uint8Array }): Promise<Uint8Array> {
  return new Uint8Array(await suite.open({ recipientKey: keys.inbox, enc: buf(sealed.enc) }, buf(sealed.ct), buf(aad)));
}

/** A record this device writes for itself: AES-256-GCM, a random 96-bit nonce, the same AAD rule. */
export async function sealForSelf(keys: Pick<ReceiptKeys, "aesKey">, aad: Uint8Array, plaintext: Uint8Array): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: buf(aad) }, keys.aesKey, buf(plaintext));
  return { iv, ct: new Uint8Array(ct) };
}

export async function openForSelf(keys: Pick<ReceiptKeys, "aesKey">, aad: Uint8Array, sealed: { iv: Uint8Array; ct: Uint8Array }): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(sealed.iv), additionalData: buf(aad) }, keys.aesKey, buf(sealed.ct));
  return new Uint8Array(pt);
}

/** A sealed receipt as it is stored and served: HPKE's `enc` and the ciphertext, base64url. */
export type SealedReceipt = {
  id: string;
  /** The buyer's address, lowercased. */
  owner: string;
  enc: string;
  ct: string;
};

/** Seal a receipt to the buyer's inbox key (`0x` + 64 hex). The server calls this with the public key only. */
export async function sealReceipt(inboxPublicKey: Hex | Uint8Array, owner: string, id: string, body: ReceiptBody): Promise<SealedReceipt> {
  const key = typeof inboxPublicKey === "string" ? fromHex(inboxPublicKey) : inboxPublicKey;
  const { enc, ct } = await sealToInbox(key, receiptAad(owner, id), te.encode(JSON.stringify(body)));
  return { id, owner: owner.toLowerCase(), enc: toBase64Url(enc), ct: toBase64Url(ct) };
}

/** Open a stored receipt with the session's keys. Throws when it isn't this owner's, or this id's. */
export async function openReceipt(keys: Pick<ReceiptKeys, "inbox">, owner: string, row: Pick<SealedReceipt, "id" | "enc" | "ct">): Promise<ReceiptBody> {
  const plaintext = await openFromInbox(keys, receiptAad(owner, row.id), { enc: fromBase64Url(row.enc), ct: fromBase64Url(row.ct) });
  try {
    return parseReceiptBody(JSON.parse(td.decode(plaintext)));
  } finally {
    plaintext.fill(0);
  }
}
