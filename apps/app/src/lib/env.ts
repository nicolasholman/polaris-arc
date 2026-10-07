import { type Address, isAddress, zeroAddress } from "viem";

/**
 * Public configuration. Every `process.env.NEXT_PUBLIC_*` read is written out
 * literally so Next inlines it at build time; nothing here is secret.
 */

function address(value: string | undefined, fallback: Address = zeroAddress): Address {
  return value && isAddress(value) ? value : fallback;
}

const API_URL = (process.env.NEXT_PUBLIC_POLARIS_API_URL?.trim() || "").replace(/\/+$/, "") || undefined;

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "10143");
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL?.trim() || undefined;

function loopback(url: string | undefined): boolean {
  try {
    return Boolean(url) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url!).hostname);
  } catch {
    return false;
  }
}

/**
 * A chain on this machine: a Hardhat node (31337), or `pnpm demo:local`'s
 * anvil fork of Monad testnet (NEXT_PUBLIC_LOCAL_FORK=1 with an RPC on
 * loopback; the chain id stays 10143).
 */
const LOCAL_CHAIN = CHAIN_ID === 31337 || (process.env.NEXT_PUBLIC_LOCAL_FORK === "1" && CHAIN_ID !== 143 && loopback(RPC_URL));

export const env = {
  /** WebAuthn relying party id. Unset means the page's hostname. */
  rpId: process.env.NEXT_PUBLIC_RP_ID?.trim() || undefined,
  /** "1" swaps Face ID for a throwaway key in sessionStorage. Dev only. */
  devSigner: process.env.NEXT_PUBLIC_DEV_SIGNER === "1",
  /**
   * Privy ("Continue with email"): the same Privy app as the dashboard. Unset
   * hides the email option; Face ID works either way.
   */
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || undefined,
  /**
   * Which Privy app client this bundle uses. The web build uses the optional
   * NEXT_PUBLIC_PRIVY_CLIENT_ID (or none). Only the Android build
   * (NEXT_PUBLIC_BUILD_TARGET=android) reads NEXT_PUBLIC_PRIVY_ANDROID_CLIENT_ID:
   * that client is locked to the Android package, and Privy rejects it on the web.
   */
  privyClientId:
    (process.env.NEXT_PUBLIC_BUILD_TARGET === "android"
      ? process.env.NEXT_PUBLIC_PRIVY_ANDROID_CLIENT_ID?.trim()
      : process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID?.trim()) || undefined,
  chainId: CHAIN_ID,
  rpcUrl: RPC_URL,
  /** A chain on this machine (a Hardhat node, or demo:local's fork of Monad testnet). */
  localChain: LOCAL_CHAIN,
  /** The block explorer. A local chain has none unless one is set. */
  explorerUrl: (process.env.NEXT_PUBLIC_EXPLORER_URL?.trim() || (LOCAL_CHAIN ? "" : "https://testnet.monadvision.com")).replace(/\/+$/, ""),
  /**
   * Polaris for Business, which runs the relayer (`/api/relay`) and serves
   * checkout sessions (`/api/public/sessions/{id}`), e.g. http://localhost:3100.
   * Required: unset, the app shows only that Polaris isn't configured on this
   * build, and nothing can be signed.
   */
  apiUrl: API_URL,
  contracts: {
    /**
     * Unset: the dollar Polaris for Business's deployment record reports
     * (network.ts), which on Monad testnet is a labelled MockAUSD while the
     * pool holds no real AUSD. Set, it pins this build: the app refuses to
     * sign if the server reports a different one.
     */
    ausd: address(process.env.NEXT_PUBLIC_AUSD_ADDRESS),
    payments: address(process.env.NEXT_PUBLIC_PAYMENTS_ADDRESS),
    checkout: address(process.env.NEXT_PUBLIC_CHECKOUT_ADDRESS),
    send: address(process.env.NEXT_PUBLIC_SEND_ADDRESS),
    /** PolarisSplit: split-the-bill links. Unset with Polaris configured: the one its deployment reports (none before deploy-split). */
    split: address(process.env.NEXT_PUBLIC_SPLIT_ADDRESS),
    loanEngine: address(process.env.NEXT_PUBLIC_LOAN_ENGINE_ADDRESS),
  },
} as const;

export type ContractName = keyof typeof env.contracts;
