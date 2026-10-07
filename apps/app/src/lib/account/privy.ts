import {
  type Address,
  getAddress,
  type Hex,
  isAddress,
  type LocalAccount,
  recoverTypedDataAddress,
  serializeTypedData,
  type TypedDataDefinition,
} from "viem";
import { toAccount } from "viem/accounts";
import { env } from "../env";
import { AccountError } from "./errors";

/**
 * The Privy path ("Continue with email"): an email code signs you in, Privy
 * keeps an embedded wallet for you, and that wallet signs the same EIP-712
 * payloads a Face ID account signs. No Privy UI is shown: the email sheet is
 * ours, and signatures are silent (the user already confirmed in the app).
 *
 * Privy's SDK lives in React (hooks inside <PrivyProvider>). The bridge
 * component (`privy-bridge.tsx`) hands this module its functions and reports
 * the session, so the account layer can use it like the other two.
 */

/** EIP-712 as eth_signTypedData_v4 JSON: EIP712Domain spelled out, integers as strings. */
export type TypedDataJson = {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
};

export type PrivyBridge = {
  sendCode: (email: string) => Promise<void>;
  loginWithCode: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  signTypedData: (data: TypedDataJson, address: Address) => Promise<Hex>;
  createWallet: () => Promise<Address | null>;
};

export type PrivyStatus = {
  /** The SDK has loaded and knows whether there is a session. */
  ready: boolean;
  authenticated: boolean;
  /** The embedded wallet, once it exists. */
  address: Address | null;
  /** The signed-in email, for the Profile screen. Never stored by us. */
  email: string | null;
};

export const PRIVY_ENABLED = Boolean(env.privyAppId);

const RECORD_KEY = "polaris.privy.v1";

let bridge: PrivyBridge | null = null;
let status: PrivyStatus = { ready: false, authenticated: false, address: null, email: null };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function onPrivyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function privyStatus(): PrivyStatus {
  return status;
}

/** Called by the bridge on every render; only real changes notify. */
export function setPrivyBridge(next: PrivyBridge | null): void {
  bridge = next;
}

export function setPrivyStatus(next: PrivyStatus): void {
  const same =
    next.ready === status.ready &&
    next.authenticated === status.authenticated &&
    next.address === status.address &&
    next.email === status.email;
  if (same) return;
  status = next;
  if (next.ready && next.authenticated && next.address) saveRecord(next.address);
  if (next.ready && !next.authenticated) forgetRecord();
  notify();
}

/* ── The public record (an address, never a key or an email) ─────────────── */

export function storedPrivyAddress(): Address | null {
  if (!PRIVY_ENABLED || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RECORD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; address?: string };
    return parsed.v === 1 && typeof parsed.address === "string" && isAddress(parsed.address)
      ? getAddress(parsed.address)
      : null;
  } catch {
    return null;
  }
}

function saveRecord(address: Address): void {
  try {
    window.localStorage.setItem(RECORD_KEY, JSON.stringify({ v: 1, address }));
  } catch {
    /* the session still works for this page */
  }
}

function forgetRecord(): void {
  try {
    window.localStorage.removeItem(RECORD_KEY);
  } catch {
    /* nothing stored */
  }
}

export const PRIVY_RECORD_KEY = RECORD_KEY;

/* ── Email sign-in ───────────────────────────────────────────────────────── */

function needBridge(): PrivyBridge {
  if (!PRIVY_ENABLED) throw new AccountError("unsupported", "Email sign-in isn't set up for this app");
  if (!bridge) throw new AccountError("unknown", "Email sign-in is still loading. Try again in a moment.");
  return bridge;
}

export async function sendEmailCode(email: string): Promise<void> {
  await needBridge().sendCode(email.trim());
}

export async function verifyEmailCode(code: string): Promise<void> {
  await needBridge().loginWithCode(code.trim());
}

/**
 * Resolves with the embedded wallet's address once Privy reports it (it is
 * created on first login), asking Privy to create one if it hasn't appeared.
 */
export function waitForPrivyWallet(timeoutMs = 20_000): Promise<Address> {
  return new Promise((resolve, reject) => {
    let asked = false;
    const started = Date.now();
    const check = () => {
      if (status.ready && status.authenticated && status.address) {
        cleanup();
        resolve(status.address);
        return;
      }
      if (status.ready && status.authenticated && !status.address && !asked && Date.now() - started > 2500) {
        asked = true;
        void bridge?.createWallet().catch(() => undefined);
      }
      if (Date.now() - started > timeoutMs) {
        cleanup();
        reject(new AccountError("unknown", "Your account took too long to open. Try again."));
      }
    };
    const timer = setInterval(check, 250);
    const unsubscribe = onPrivyChange(check);
    const cleanup = () => {
      clearInterval(timer);
      unsubscribe();
    };
    check();
  });
}

export async function privyLogout(): Promise<void> {
  forgetRecord();
  await bridge?.logout().catch(() => undefined);
}

/* ── The signer ──────────────────────────────────────────────────────────── */

/** viem's typed data → the JSON Privy's wallet signs (EIP712Domain included, bigints as strings). */
export function toTypedDataJson(typed: TypedDataDefinition): TypedDataJson {
  return JSON.parse(serializeTypedData(typed)) as TypedDataJson;
}

/**
 * The embedded wallet as a viem account, so `lib/actions.ts` signs through
 * it exactly as through a Face ID account. Every signature is checked to
 * recover to the wallet before it is used.
 */
export function privyAccount(address: Address): LocalAccount {
  const refuse = async (): Promise<never> => {
    throw new Error("Polaris accounts only sign typed data");
  };
  return toAccount({
    address,
    signMessage: refuse,
    signTransaction: refuse,
    async signTypedData(typed) {
      const definition = typed as unknown as TypedDataDefinition;
      const signature = await needBridge().signTypedData(toTypedDataJson(definition), address);
      const signer = await recoverTypedDataAddress({ ...definition, signature } as Parameters<
        typeof recoverTypedDataAddress
      >[0]);
      if (getAddress(signer) !== getAddress(address)) {
        throw new AccountError("unknown", "That signature didn't come from your account");
      }
      return signature;
    },
  });
}
