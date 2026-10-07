import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  type PasskeyCredentialMetadata,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { deriveReceiptKeys, type ReceiptKeys } from "@polaris/receipts";
import type { LocalAccount } from "viem";
import { deriveEvmKey } from "./derive";

/**
 * The Mera path: Face ID → PRF (32 bytes) → secp256k1 key → viem account.
 * This is the entire account layer. There is no seed phrase to write down,
 * no extension, and no server that holds a key.
 *
 * The same PRF output also gives the receipt keys (@polaris/receipts: an
 * AES-256-GCM key and the X25519 inbox key pair, each from its own HKDF
 * label), in the same ceremony: no second Face ID. The wallet derivation
 * (derive.ts) is unchanged and runs first.
 */

export type OpenedSession = {
  account: LocalAccount;
  /** Zeroes the signing key. Signing afterwards throws SESSION_ENDED. */
  end: () => void;
  /** The receipt keys, in memory for this session only; null if this browser couldn't derive them. */
  receipts: ReceiptKeys | null;
  credentialId: string;
  transports?: readonly string[];
};

/** PRF output → a live signing session and the receipt keys. The caller's copies are wiped. */
async function openSession(prfOutput: Uint8Array): Promise<Pick<OpenedSession, "account" | "end" | "receipts">> {
  try {
    const privateKey = deriveEvmKey(prfOutput);
    let opened: Pick<OpenedSession, "account" | "end">;
    try {
      const session = createSecp256k1SigningSession({ privateKey });
      opened = { account: toViemAccount(session), end: () => session.end() };
    } finally {
      privateKey.fill(0);
    }
    // Receipts are a convenience on top of the account: if they can't be derived here, signing still works.
    const receipts = await deriveReceiptKeys(prfOutput).catch(() => null);
    return { ...opened, receipts };
  } finally {
    prfOutput.fill(0);
  }
}

/**
 * Creates a NEW passkey, and so a NEW account. Every call adds one: call it
 * only from an explicit click, never from an effect (StrictMode runs effects
 * twice in dev, and two creates are two accounts).
 */
export async function meraCreate(rpId: string): Promise<OpenedSession> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: rpId, name: "Polaris" },
    user: {
      name: "Polaris",
      // Shown in the system picker; the date keeps several apart.
      displayName: `Polaris account (${new Date().toLocaleDateString()})`,
    },
  });
  const { account, end, receipts } = await openSession(created.prfOutput);
  return {
    account,
    end,
    receipts,
    credentialId: created.credentialId,
    ...(created.transports ? { transports: created.transports } : {}),
  };
}

/**
 * Signs back in to an existing account. With `credential`, Face ID goes
 * straight to that passkey; without it, the system shows every Polaris
 * passkey on the device (a new phone, the other subdomain, an installed app).
 */
export async function meraSignIn(rpId: string, credential?: PasskeyCredentialMetadata): Promise<OpenedSession> {
  const { credentialId, prfOutput } = await getPasskeyPrfOutput({
    rpId,
    ...(credential ? { credential } : {}),
  });
  const { account, end, receipts } = await openSession(prfOutput);
  return { account, end, receipts, credentialId };
}
