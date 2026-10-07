import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
// Pure-JS X25519, so sealing and opening never depend on WebCrypto X25519 in the browser.
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

/**
 * "Receipts only you can read": the non-wallet keys one Face ID gives.
 *
 * The passkey's PRF output (32 bytes, the same output the wallet key comes
 * from) goes through HKDF-SHA-256 once per purpose, each with its own label,
 * so the keys are independent of each other and of the wallet key:
 *
 *   polaris/v1/receipts/aes-256-gcm       an AES-256-GCM key (records this device writes for itself)
 *   polaris/v1/receipts/hpke-x25519-ikm   the seed of an X25519 "inbox" key pair (RFC 9180 DeriveKeyPair)
 *
 * The wallet path (PRF → BIP-39 → m/44'/60'/0'/0/0) is untouched. Nothing
 * here is stored: every Face ID derives the same keys again. Rules from
 * docs/research/mera.md §16.2: never the PRF output as a key, one label per
 * key, version the labels (rotation is a new label), non-extractable keys,
 * intermediate bytes zeroed, and never Mera's own `mera.v1.encrypt.secret`.
 *
 * Changing either label orphans every receipt sealed so far.
 */

const te = new TextEncoder();

export const AES_LABEL = "polaris/v1/receipts/aes-256-gcm";
export const HPKE_LABEL = "polaris/v1/receipts/hpke-x25519-ikm";

const AES_INFO = te.encode(AES_LABEL);
const HPKE_INFO = te.encode(HPKE_LABEL);

/** RFC 9180: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. */
export const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export type ReceiptKeys = {
  /** Non-extractable AES-256-GCM key for records this device writes and reads. */
  aesKey: CryptoKey;
  /** The HPKE X25519 key pair; only the public half ever leaves the device. */
  inbox: CryptoKeyPair;
  /** 32 bytes. Registered with Polaris so anyone can seal a receipt to the buyer. */
  inboxPublicKey: Uint8Array;
};

/** A copy on its own ArrayBuffer, which WebCrypto's types (and a later zeroing) want. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/**
 * The receipt keys from a 32-byte PRF output. Deterministic: the same
 * passkey gives the same keys on every device and every sign-in. The
 * caller still owns (and zeroes) `prfOutput`; the copies made here are
 * zeroed before this returns.
 */
export async function deriveReceiptKeys(prfOutput: Uint8Array): Promise<ReceiptKeys> {
  if (prfOutput.length !== 32) throw new Error("PRF output must be 32 bytes");
  const material = own(prfOutput);
  let seed: Uint8Array<ArrayBuffer> | null = null;
  try {
    // HKDF with an empty salt: the PRF output is already uniformly random (Mera assumes the same).
    const ikm = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey", "deriveBits"]);
    const aesKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: AES_INFO },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    seed = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HPKE_INFO }, ikm, 256),
    );
    // RFC 9180 §7.1.3 DeriveKeyPair: the same seed, the same key pair, nothing stored.
    const inbox = await suite.kem.deriveKeyPair(seed.buffer);
    const inboxPublicKey = new Uint8Array(await suite.kem.serializePublicKey(inbox.publicKey));
    return { aesKey, inbox, inboxPublicKey };
  } finally {
    material.fill(0);
    seed?.fill(0);
  }
}

/**
 * Drop what can be dropped of a session's receipt keys. The AES key is a
 * non-extractable CryptoKey (the browser holds its bytes); the pure-JS
 * X25519 private key keeps its scalar in a byte array, which is zeroed.
 */
export function forgetReceiptKeys(keys: ReceiptKeys): void {
  const priv = keys.inbox.privateKey as unknown as { key?: unknown };
  if (priv && priv.key instanceof Uint8Array) priv.key.fill(0);
}
