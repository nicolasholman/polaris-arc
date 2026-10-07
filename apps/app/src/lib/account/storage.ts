import { type Address, isAddress } from "viem";

/**
 * The only thing an account ever writes to disk: public metadata that pins
 * the next Face ID to the right passkey and lets Home show the right account
 * without a prompt. No PRF output, seed or private key is ever stored; each
 * sign-in recomputes the key from Face ID.
 */
export type StoredAccount = {
  v: 1;
  /** Canonical base64url credential id. Public. */
  credentialId: string;
  /** Routing hint for the next ceremony ("internal", "hybrid", ...). Public. */
  transports?: string[];
  /** The relying party the passkey was made for. */
  rpId: string;
  /** The account's public address, for reads before Face ID. */
  address: Address;
  createdAt: number;
};

const KEY = "polaris.account.v1";

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<StoredAccount>;
  return (
    v.v === 1 &&
    typeof v.credentialId === "string" &&
    v.credentialId.length > 0 &&
    typeof v.rpId === "string" &&
    typeof v.address === "string" &&
    isAddress(v.address) &&
    typeof v.createdAt === "number" &&
    (v.transports === undefined || (Array.isArray(v.transports) && v.transports.every((t) => typeof t === "string")))
  );
}

export function loadStoredAccount(): StoredAccount | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredAccount(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveStoredAccount(account: StoredAccount): void {
  // Whitelist the fields so nothing else can ride along into storage.
  const record: StoredAccount = {
    v: 1,
    credentialId: account.credentialId,
    rpId: account.rpId,
    address: account.address,
    createdAt: account.createdAt,
    ...(account.transports ? { transports: [...account.transports] } : {}),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Private mode or storage full: the next sign-in falls back to the picker.
  }
}

export function forgetStoredAccount(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}

export const STORED_ACCOUNT_KEY = KEY;
