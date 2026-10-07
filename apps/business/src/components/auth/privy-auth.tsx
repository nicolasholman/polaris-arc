"use client";

import wordmark from "@polaris/brand/assets/wordmark.png";
import {
  addRpcUrlOverrideToChain,
  PrivyProvider,
  usePrivy,
  useSigners,
  useSignTypedData,
  useWallets,
  type PrivyClientConfig,
} from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { monad, monadTestnet } from "viem/chains";

import { AuthContext, type AuthState, type WalletActions } from "@/lib/auth-context";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
// A Privy "app client" for this web origin, if one exists. Never the Android
// build's client id (NEXT_PUBLIC_PRIVY_ANDROID_CLIENT_ID): that one is for the
// native app only.
const CLIENT_ID = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || undefined;
const TESTNET_RPC = process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC || "";

/** How long Privy may take to become ready before we say it can't be reached. */
const READY_TIMEOUT_MS = 8000;

// Point the embedded wallet at our own RPC when we have one; Privy has no
// hosted RPC for Monad testnet, and the public one is rate-limited.
const testnet = TESTNET_RPC ? addRpcUrlOverrideToChain(monadTestnet, TESTNET_RPC) : monadTestnet;

type StaticImage = { src: string };
const WORDMARK_SRC = typeof wordmark === "string" ? wordmark : (wordmark as StaticImage).src;

const PRIVY_CONFIG: PrivyClientConfig = {
  // No `loginMethods`: the modal lists exactly what the Privy dashboard has
  // turned on (email and wallets today; Google appears once it's enabled
  // there). We never draw a button for a method that is off.
  embeddedWallets: {
    // Every merchant gets a self-custodial payout wallet at sign-in, even one
    // who signs in with an external wallet (the dashboard default is off).
    ethereum: { createOnLogin: "all-users" },
  },
  defaultChain: testnet,
  supportedChains: [testnet, monad],
  appearance: {
    // Our surface-1 as the modal's ground (Privy derives its greys from it),
    // and lime for its primary button: the modal reads as part of the page.
    theme: "#1A1B1D",
    accentColor: "#9CEF5E",
    // Privy wants a URL string (a React node renders nothing): the team's
    // wordmark from packages/brand, as the static import's URL. Privy also
    // server-renders a hidden preload <img> of it, so the string must be the
    // same on the server and in the browser.
    logo: WORDMARK_SRC,
    landingHeader: "Sign in to Polaris for Business",
    loginMessage: "Payment links with credit built in. Paid in full, in dollars, in under a second.",
    walletChainType: "ethereum-only",
    showWalletLoginFirst: false,
  },
};

/** Privy, and the dashboard's view of it (AuthContext). */
export function PrivyAuthProvider({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider appId={APP_ID} clientId={CLIENT_ID} config={PRIVY_CONFIG}>
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signTypedData } = useSignTypedData();
  const { addSigners, removeSigners } = useSigners();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [ready]);

  const embedded = wallets.find((w) => w.walletClientType === "privy") ?? null;
  const address = (embedded?.address ?? null) as `0x${string}` | null;

  const wallet = useMemo<WalletActions>(
    () => ({
      address,
      signer: "privy",
      ready: walletsReady,
      signTypedData: async (data, ui) => {
        if (!address) throw new Error("Your payout account is still being set up. Try again in a moment.");
        const { signature } = await signTypedData(data as Parameters<typeof signTypedData>[0], {
          address,
          uiOptions: { title: ui.title, buttonText: ui.buttonText },
        });
        return signature as `0x${string}`;
      },
      addPayoutSigner: async (signerId, policyIds) => {
        if (!address) throw new Error("Your payout account is still being set up. Try again in a moment.");
        await addSigners({ address, signers: [{ signerId, policyIds }] });
      },
      removePayoutSigners: async () => {
        if (address) await removeSigners({ address });
      },
    }),
    [address, walletsReady, signTypedData, addSigners, removeSigners],
  );

  const doLogin = useCallback(() => login(), [login]);
  const retry = useCallback(() => window.location.reload(), []);

  const value = useMemo<AuthState>(
    () => ({
      status: ready ? (authenticated ? "signed-in" : "signed-out") : timedOut ? "unreachable" : "loading",
      user: user ? { id: user.id, email: user.email?.address ?? user.google?.email ?? null } : null,
      login: doLogin,
      logout,
      getAccessToken,
      retry,
      wallet,
    }),
    [ready, authenticated, timedOut, user, doLogin, logout, getAccessToken, retry, wallet],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** No Privy app id in this build: pages that need sign-in show the setup screen. */
export function UnconfiguredAuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AuthState>(
    () => ({
      status: "unconfigured",
      user: null,
      login: () => undefined,
      logout: async () => undefined,
      getAccessToken: async () => null,
      retry: () => window.location.reload(),
      wallet: {
        address: null,
        signer: "none",
        ready: false,
        signTypedData: async () => Promise.reject(new Error("Sign-in isn't configured.")),
        addPayoutSigner: async () => Promise.reject(new Error("Sign-in isn't configured.")),
        removePayoutSigners: async () => undefined,
      },
    }),
    [],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const PRIVY_CONFIGURED = Boolean(APP_ID);
