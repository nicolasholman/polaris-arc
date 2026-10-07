import { deriveReceiptKeys, type ReceiptKeys } from "@polaris/receipts";
import { type Hex, hexToBytes } from "viem";

/** The label that turns the dev key into a stand-in for a passkey's PRF output. Dev only. */
export const DEV_PRF_LABEL = "polaris/dev/v1/prf-stand-in";

/**
 * The dev signer's receipt keys, so headless runs exercise the same sealing
 * as Face ID: HKDF(dev key, DEV_PRF_LABEL) stands in for the 32-byte PRF
 * output, then the real derivation (@polaris/receipts) runs on it.
 */
export async function devReceiptKeys(privateKey: Hex): Promise<ReceiptKeys | null> {
  const key = new Uint8Array(hexToBytes(privateKey));
  let standIn: Uint8Array | null = null;
  try {
    const ikm = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
    standIn = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(DEV_PRF_LABEL) }, ikm, 256),
    );
    return await deriveReceiptKeys(standIn);
  } catch {
    return null;
  } finally {
    key.fill(0);
    standIn?.fill(0);
  }
}
