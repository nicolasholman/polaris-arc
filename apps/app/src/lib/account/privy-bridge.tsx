"use client";

import {
  PrivyProvider,
  useCreateWallet,
  useLoginWithEmail,
  usePrivy,
  useSignTypedData,
  useWallets,
} from "@privy-io/react-auth";
import { type ReactNode, useEffect, useRef } from "react";
import { type Address, getAddress, type Hex } from "viem";
import { chain } from "../chain";
import { env } from "../env";
import { PRIVY_ENABLED, setPrivyBridge, setPrivyStatus, type TypedDataJson } from "./privy";

/**
 * Mounts Privy for "Continue with email" and connects it to the account
 * layer. Headless: our own sheet asks for the email and the code, the
 * embedded wallet is created on login (the dashboard leaves that off, so the
 * client asks for it), and signatures never show a Privy prompt.
 */
export function AccountProviders({ children }: { children: ReactNode }) {
  if (!PRIVY_ENABLED || !env.privyAppId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={env.privyAppId}
      // The web app client, or the Android app's when NEXT_PUBLIC_BUILD_TARGET=android (see env.ts).
      {...(env.privyClientId ? { clientId: env.privyClientId } : {})}
      config={{
        // Google is off in the Privy app, so email is the one method offered.
        loginMethods: ["email"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          showWalletUIs: false,
        },
        defaultChain: chain,
        supportedChains: [chain],
        appearance: { theme: "dark", accentColor: "#9CEF5E", walletChainType: "ethereum-only" },
      }}
    >
      <PrivyBridge />
      {children}
    </PrivyProvider>
  );
}

function PrivyBridge() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { signTypedData } = useSignTypedData();
  const { createWallet } = useCreateWallet();

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const address = (embedded?.address ?? (user?.wallet?.walletClientType === "privy" ? user.wallet.address : null)) as
    | Address
    | null
    | undefined;

  // Privy's functions change identity between renders; the account layer
  // always calls the latest.
  const latest = useRef({ sendCode, loginWithCode, signTypedData, createWallet, logout });
  useEffect(() => {
    latest.current = { sendCode, loginWithCode, signTypedData, createWallet, logout };
  });

  useEffect(() => {
    setPrivyBridge({
      sendCode: (email) => latest.current.sendCode({ email }),
      loginWithCode: (code) => latest.current.loginWithCode({ code }),
      logout: () => latest.current.logout(),
      async signTypedData(data: TypedDataJson, from: Address) {
        const { signature } = await latest.current.signTypedData(data as Parameters<typeof signTypedData>[0], {
          address: from,
          uiOptions: { showWalletUIs: false },
        });
        return signature as Hex;
      },
      async createWallet() {
        const wallet = await latest.current.createWallet();
        return wallet?.address ? (getAddress(wallet.address) as Address) : null;
      },
    });
    return () => setPrivyBridge(null);
  }, []);

  useEffect(() => {
    setPrivyStatus({
      ready: ready && (!authenticated || walletsReady),
      authenticated,
      address: authenticated && address ? getAddress(address) : null,
      email: authenticated ? (user?.email?.address ?? null) : null,
    });
  }, [ready, authenticated, walletsReady, address, user?.email?.address]);

  return null;
}
