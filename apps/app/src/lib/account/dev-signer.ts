import type { ReceiptKeys } from "@polaris/receipts";
import { type Hex, isHex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { devReceiptKeys } from "./dev-receipts";
import { AccountError } from "./errors";

/**
 * DEV ONLY. A random key in this tab's sessionStorage stands in for Face ID so
 * flows can run headlessly (CI, a PC without a PRF authenticator).
 *
 * It can't run by accident:
 *   1. This module is only ever loaded through a dynamic import behind
 *      `NEXT_PUBLIC_DEV_SIGNER === "1"`, which Next inlines at build time, so
 *      a build without the flag never calls into it.
 *   2. Every entry point re-checks the flag and throws without it.
 *   3. It refuses to run on the production domain whatever the flag says.
 * The UI shows a "Dev signer" badge whenever it is on.
 *
 * The key lives in the tab's sessionStorage, so each tab is a new account.
 * `NEXT_PUBLIC_DEV_SIGNER_PERSIST=1` (set by `pnpm demo:local`) keeps it in
 * localStorage instead, the way a passkey belongs to the device: a shop's
 * checkout popup then opens as the same buyer as the app's own tab.
 */

const KEY = "polaris.dev-signer.v1";

/** Where the key is kept: the tab, or (demo:local) the device. */
function store(): Storage {
  return process.env.NEXT_PUBLIC_DEV_SIGNER_PERSIST === "1" ? window.localStorage : window.sessionStorage;
}
const PRODUCTION_DOMAIN = "polarispay.app";

type DevRecord = { privateKey: Hex; createdAt: number };

function assertEnabled(): void {
  if (process.env.NEXT_PUBLIC_DEV_SIGNER !== "1") {
    throw new Error("The dev signer is disabled. Set NEXT_PUBLIC_DEV_SIGNER=1 in a dev build to use it.");
  }
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  if (host === PRODUCTION_DOMAIN || host.endsWith(`.${PRODUCTION_DOMAIN}`)) {
    throw new Error("The dev signer never runs on the production domain.");
  }
}

function read(): DevRecord | null {
  try {
    const raw = store().getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DevRecord>;
    if (typeof parsed.privateKey === "string" && isHex(parsed.privateKey) && parsed.privateKey.length === 66) {
      return { privateKey: parsed.privateKey, createdAt: Number(parsed.createdAt) || Date.now() };
    }
    return null;
  } catch {
    return null;
  }
}

export type DevSession = { account: LocalAccount; createdAt: number; receipts: ReceiptKeys | null };

async function open(record: DevRecord): Promise<DevSession> {
  return { account: privateKeyToAccount(record.privateKey), createdAt: record.createdAt, receipts: await devReceiptKeys(record.privateKey) };
}

export async function devCreate(): Promise<DevSession> {
  assertEnabled();
  const record: DevRecord = { privateKey: generatePrivateKey(), createdAt: Date.now() };
  try {
    store().setItem(KEY, JSON.stringify(record));
  } catch {
    /* the account still works for this page */
  }
  return open(record);
}

export async function devSignIn(): Promise<DevSession> {
  assertEnabled();
  const record = read();
  if (!record) throw new AccountError("no-account", "No dev account in this tab yet");
  return open(record);
}

/** The dev account's public address, for "locked" state. Never the key. */
export function devStoredAddress(): Hex | null {
  assertEnabled();
  const record = read();
  return record ? privateKeyToAccount(record.privateKey).address : null;
}

/** When the dev account was created, for "Member since". */
export function devCreatedAt(): number | null {
  assertEnabled();
  return read()?.createdAt ?? null;
}

export function devForget(): void {
  assertEnabled();
  try {
    store().removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}
