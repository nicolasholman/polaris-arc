"use client";

import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { privateKeyToAccount } from "viem/accounts";

import { AuthContext, LOCAL_SESSION_TOKEN, type AuthState } from "@/lib/auth-context";

/**
 * The demo merchant's payout wallet on the local chain: a key `pnpm
 * demo:local` makes for each run (a throwaway, like Hardhat's own accounts),
 * so the dashboard can sign its registration and withdrawals the way Privy's
 * embedded wallet does. Without it, the address alone (display only).
 */
const LOCAL_SESSION_KEY = /^0x[0-9a-fA-F]{64}$/.test(process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION_KEY ?? "")
  ? privateKeyToAccount(process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION_KEY as `0x${string}`)
  : null;
/** The demo merchant's address, for display (the server takes it from its own config, never from here). */
const LOCAL_SESSION_WALLET =
  LOCAL_SESSION_KEY?.address ??
  (/^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION_WALLET ?? "")
    ? (process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION_WALLET as `0x${string}`)
    : null);

const SIGNED_OUT_KEY = "polaris:local-session-signed-out";
const listeners = new Set<() => void>();

function readSignedOut(): boolean {
  try {
    return window.sessionStorage.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSignedOut(out: boolean) {
  try {
    if (out) window.sessionStorage.setItem(SIGNED_OUT_KEY, "1");
    else window.sessionStorage.removeItem(SIGNED_OUT_KEY);
  } catch {}
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * DEVELOPMENT ONLY: `pnpm demo:local`'s signed-in dashboard. It reads and
 * writes the real API, as the demo merchant on the local chain: the server accepts this run's random token only there (server/auth.ts
 * `localSession`). Its wallet signs with this run's throwaway key
 * (registration, withdrawals); Privy's automatic payouts aren't available.
 */
export function LocalAuthProvider({ children }: { children: ReactNode }) {
  const signedOut = useSyncExternalStore<boolean | null>(subscribe, readSignedOut, () => null);
  const login = useCallback(() => writeSignedOut(false), []);
  const logout = useCallback(async () => writeSignedOut(true), []);

  const value = useMemo<AuthState>(() => {
    const unavailable = async (): Promise<never> => {
      throw new Error("The local demo session can't do this without Privy.");
    };
    const signTypedData: AuthState["wallet"]["signTypedData"] = async (data) => {
      if (!LOCAL_SESSION_KEY) throw new Error("The local demo session has no wallet key to sign with.");
      // The server sends integers as decimal strings (as Privy takes them); viem wants bigints.
      const fields = data.types[data.primaryType] ?? [];
      const message = Object.fromEntries(
        Object.entries(data.message).map(([k, v]) => {
          const type = fields.find((f) => f.name === k)?.type ?? "";
          return [k, /^u?int\d*$/.test(type) && (typeof v === "string" || typeof v === "number") ? BigInt(v) : v];
        }),
      );
      const { EIP712Domain: _domain, ...types } = data.types as Record<string, readonly { name: string; type: string }[]>;
      void _domain;
      return LOCAL_SESSION_KEY.signTypedData({ domain: data.domain, types, primaryType: data.primaryType, message } as unknown as Parameters<
        typeof LOCAL_SESSION_KEY.signTypedData
      >[0]);
    };
    return {
      status: signedOut === null ? "loading" : signedOut ? "signed-out" : "signed-in",
      user: signedOut === false ? { id: "local-demo-merchant", email: null } : null,
      login,
      logout,
      getAccessToken: async () => (signedOut ? null : LOCAL_SESSION_TOKEN),
      retry: () => window.location.reload(),
      wallet: {
        address: LOCAL_SESSION_WALLET,
        signer: "local",
        ready: true,
        signTypedData,
        addPayoutSigner: unavailable,
        removePayoutSigners: unavailable,
      },
    };
  }, [signedOut, login, logout]);

  if (!LOCAL_SESSION_TOKEN) return null;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
