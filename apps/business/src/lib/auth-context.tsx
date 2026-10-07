"use client";

import { createContext, useContext } from "react";

/**
 * The sign-in state every page reads, whichever way it is provided: Privy in
 * every real build, or `pnpm demo:local`'s local session in development.
 */
export type AuthStatus =
  /** Privy is starting up. */
  | "loading"
  | "signed-out"
  | "signed-in"
  /** Privy never became ready: the network, a blocker or a firewall. */
  | "unreachable"
  /** No Privy app id in this build: nothing to sign in with. */
  | "unconfigured";

export type AuthUser = { id: string; email: string | null };

/** EIP-712 typed data, as Privy's signTypedData takes it (uint256 as decimal strings). */
export type TypedDataInput = {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

/**
 * What the dashboard asks of the merchant's embedded wallet. Only the auth
 * provider touches Privy's wallet hooks, so pages work the same under the
 * local session (which signs with its own throwaway key).
 */
export type WalletActions = {
  /** The embedded payout wallet, once Privy has created it. */
  address: `0x${string}` | null;
  /**
   * What signs for this wallet: Privy's embedded wallet behind the merchant's
   * sign-in, `demo:local`'s throwaway key for this run, or nothing (no sign-in
   * configured). Settings says which.
   */
  signer: "privy" | "local" | "none";
  ready: boolean;
  signTypedData: (data: TypedDataInput, ui: { title: string; buttonText: string }) => Promise<`0x${string}`>;
  addPayoutSigner: (signerId: string, policyIds: string[]) => Promise<void>;
  removePayoutSigners: () => Promise<void>;
};

export type AuthState = {
  status: AuthStatus;
  user: AuthUser | null;
  /** Opens Privy's modal (it shows only the methods enabled for the app). */
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  /** Reload after "unreachable". */
  retry: () => void;
  wallet: WalletActions;
};

export const AuthContext = createContext<AuthState | null>(null);

/** What Settings says signs the merchant's withdrawals and registration. */
export const SIGNER_LABEL: Record<WalletActions["signer"], string> = {
  privy: "Your sign-in's embedded wallet (Privy)",
  local: "This demo run's local key (demo:local)",
  none: "Nothing yet: sign-in isn't configured",
};

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside the AuthProvider (the (privy) layout).");
  return ctx;
}

/** For components that also render outside the provider (the landing nav in a static render). */
export function useOptionalAuth(): AuthState | null {
  return useContext(AuthContext);
}

/**
 * `pnpm demo:local`'s signed-in dashboard: the demo merchant's real book on
 * a local chain, without Privy. The token is random per run and the server
 * accepts it only on a local chain in development (server/auth.ts
 * `localSession`); it is the literal "" in a production build.
 */
export const LOCAL_SESSION_TOKEN =
  process.env.NODE_ENV === "development" ? (process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION ?? "") : "";

