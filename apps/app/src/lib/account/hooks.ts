"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { type AccountState, getServerSnapshot, getSnapshot, subscribe } from "./index";
import { emailLoginOpen, subscribeEmailLogin } from "./email-login";
import { onPrivyChange, type PrivyStatus, privyStatus } from "./privy";
import { type AccountSupport, checkAccountSupport, isInAppBrowser } from "./support";

/** The account's state, kept in sync across the app (and other tabs). */
export function useAccountState(): AccountState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export type SupportState = { status: "checking" } | ({ status: "done" } & AccountSupport);

// Checked once per page load; every later mount (a sheet, the next screen) gets the answer at once.
let supportResult: SupportState | null = null;
let supportPending: Promise<SupportState> | null = null;

function loadSupport(): Promise<SupportState> {
  supportPending ??= checkAccountSupport().then((result) => {
    supportResult = { status: "done", ...result };
    return supportResult;
  });
  return supportPending;
}

/** Whether this browser can hold an account. Reads only; never starts a ceremony. */
export function useAccountSupport(): SupportState {
  const [state, setState] = useState<SupportState>(() => supportResult ?? { status: "checking" });
  useEffect(() => {
    if (supportResult) return;
    let live = true;
    void loadSupport().then((result) => {
      if (live) setState(result);
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** True inside an Instagram/Facebook/TikTok-style WebView. */
export function useInAppBrowser(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => isInAppBrowser(navigator.userAgent),
    () => false,
  );
}

/** Privy's session, for the Profile screen (the signed-in email). */
export function usePrivyStatus(): PrivyStatus {
  return useSyncExternalStore(onPrivyChange, privyStatus, () => SERVER_PRIVY);
}

const SERVER_PRIVY: PrivyStatus = { ready: false, authenticated: false, address: null, email: null };

/** Whether the email sheet is open (see email-login.ts). */
export function useEmailLoginOpen(): boolean {
  return useSyncExternalStore(subscribeEmailLogin, emailLoginOpen, () => false);
}

/** The address data is read for: the account on this device, or null (none yet). */
export function useOwner(): `0x${string}` | null {
  const state = useAccountState();
  return state.status === "ready" || state.status === "locked" ? state.address : null;
}
