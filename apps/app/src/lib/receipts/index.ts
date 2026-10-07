"use client";

import { openReceipt, type ReceiptBody, receiptsReadMessage } from "@polaris/receipts";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { getAccount, receiptKeys, signIn, subscribe as subscribeAccount, toAccountError, describeAccountError } from "../account";
import { api, apiConfigured, NOT_CONFIGURED_MESSAGE } from "../api";

/**
 * Opening the receipts only the buyer can read.
 *
 * The server holds them as HPKE ciphertext sealed to the buyer's inbox key
 * (apps/business src/server/receipts.ts). Reading them takes two things the
 * open Face ID session has and nothing else does: the account's signature
 * (to fetch them, `POST /api/receipts`) and the inbox private key (to open
 * them). With a session open that is no prompt at all; with the account
 * locked it is the one Face ID that opens it.
 *
 * What opens is kept in memory for the session and dropped with it.
 */

type Row = { id: string; enc: string; ct: string };

export type ReceiptsState =
  /** Nothing opened yet, and the session can open them without a prompt. */
  | { status: "idle" }
  /** The account is locked (or has no receipt keys in this session): Face ID opens them. */
  | { status: "locked" }
  | { status: "opening" }
  | { status: "open"; owner: string; receipts: ReadonlyMap<string, ReceiptBody>; unreadable: number }
  | { status: "error"; message: string };

let state: ReceiptsState = { status: "idle" };
let inflight: Promise<void> | null = null;
/** Receipts already looked for again after an opening that didn't have them. */
const refetched = new Set<string>();
const listeners = new Set<() => void>();

function set(next: ReceiptsState): void {
  state = next;
  for (const l of listeners) l();
}

// The session ended or another account opened: what was opened goes with it.
let watching = false;
function watchAccount(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  subscribeAccount(() => {
    const account = getAccount();
    if (state.status === "open" && (!account || account.address.toLowerCase() !== state.owner)) set({ status: "idle" });
  });
}

function subscribe(listener: () => void): () => void {
  watchAccount();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fetch and open this account's receipts with the open session. Throws when there is no session with keys. */
async function openWithSession(): Promise<void> {
  const account = getAccount();
  const keys = receiptKeys();
  if (!account || !keys) {
    set({ status: "locked" });
    return;
  }
  if (!apiConfigured()) {
    // Nothing to read receipts from, so nothing is signed.
    set({ status: "error", message: NOT_CONFIGURED_MESSAGE });
    return;
  }
  set({ status: "opening" });
  const issuedAt = Math.floor(Date.now() / 1000);
  try {
    const signature = await account.signMessage({ message: receiptsReadMessage(account.address, issuedAt) });
    const { receipts } = await api<{ receipts: Row[] }>("/api/receipts", { method: "POST", body: { address: account.address, issuedAt, signature } });
    const opened = new Map<string, ReceiptBody>();
    let unreadable = 0;
    for (const row of receipts) {
      try {
        opened.set(row.id, await openReceipt(keys, account.address, row));
      } catch {
        // Not this account's, not this id's, or tampered with: never shown.
        unreadable++;
      }
    }
    set({ status: "open", owner: account.address.toLowerCase(), receipts: opened, unreadable });
  } catch (error) {
    set({ status: "error", message: (error as Error).message || "We couldn't open your receipts. Try again." });
  }
}

function run(task: () => Promise<void>): Promise<void> {
  inflight ??= task().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** For "Open with Face ID": the ceremony first (the click's user gesture), then the receipts. */
export function unlockReceipts(): Promise<void> {
  return run(async () => {
    if (!receiptKeys()) {
      try {
        await signIn();
      } catch (error) {
        const err = toAccountError(error);
        set(err.kind === "cancelled" ? { status: "locked" } : { status: "error", message: describeAccountError(err) });
        return;
      }
    }
    await openWithSession();
  });
}

export type Receipt = {
  /** What the row's receipt says, with the receipt it refers to (an instalment's plan) folded in. */
  body: ReceiptBody;
  /** The receipt it belongs to, when it is one (a plan, a subscription). */
  parent: ReceiptBody | null;
};

/**
 * One activity row's sealed receipt: locked until a Face ID session opens
 * it, then what was bought. `receiptId` undefined means the row has none
 * (an email account's, a transfer, the offline demo).
 */
export function useReceipt(receiptId: string | undefined, owner: Address | null) {
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  const canOpenSilently = Boolean(receiptId && owner && getAccount()?.address.toLowerCase() === owner.toLowerCase() && receiptKeys());

  const missing = Boolean(receiptId && current.status === "open" && !current.receipts.has(receiptId));
  useEffect(() => {
    if (!canOpenSilently || !receiptId) return;
    // A live session opens them without asking: signing a read request needs no Face ID.
    if (current.status === "idle" || current.status === "locked") void run(openWithSession);
    // Sealed after they were opened (a payment just now): read them again, once per receipt.
    else if (missing && !refetched.has(receiptId)) {
      refetched.add(receiptId);
      void run(openWithSession);
    }
  }, [canOpenSilently, current.status, missing, receiptId]);

  const unlock = useCallback(() => unlockReceipts(), []);

  if (!receiptId) return { status: "none" as const, unlock };
  if (current.status === "open") {
    const body = current.receipts.get(receiptId);
    if (!body) return { status: "missing" as const, unlock };
    const parent = body.refersTo ? (current.receipts.get(body.refersTo) ?? null) : null;
    return { status: "open" as const, receipt: { body, parent } satisfies Receipt, unlock };
  }
  if (current.status === "opening") return { status: "opening" as const, unlock };
  if (current.status === "error") return { status: "error" as const, message: current.message, unlock };
  return { status: canOpenSilently ? ("opening" as const) : ("locked" as const), unlock };
}

/** What was bought, in one line: the receipt's description, or its parent's. */
export function receiptWhat(r: Receipt): string | null {
  return r.body.description ?? r.parent?.description ?? null;
}
