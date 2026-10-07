import { type Address, isAddress, zeroAddress } from "viem";

/**
 * Public configuration. Every `process.env.NEXT_PUBLIC_*` read is written out
 * literally so Next inlines it at build time; nothing here is secret.
 */

function address(value: string | undefined, fallback: Address = zeroAddress): Address {
  return value && isAddress(value) ? value : fallback;
}

/** Arc mainnet and Arc testnet. */
export const ARC_MAINNET = 5042;
export const ARC_TESTNET = 5042002;
/** A Hardhat node on this machine (`pnpm --filter @polarispay/contracts node:local`). */
export const LOCAL_CHAIN_ID = 31337;

/** Each Arc network's public explorer (Blockscout). */
const ARC_EXPLORERS: Readonly<Record<number, string>> = {
  [ARC_MAINNET]: "https://explorer.arc.io",
  [ARC_TESTNET]: "https://explorer.testnet.arc.io",
};

const API_URL = (process.env.NEXT_PUBLIC_POLARIS_API_URL?.trim() || "").replace(/\/+$/, "") || undefined;

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || ARC_TESTNET);
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL?.trim() || undefined;

/** A chain on this machine: a Hardhat node (31337). It has no explorer and a local faucet. */
const LOCAL_CHAIN = CHAIN_ID === LOCAL_CHAIN_ID;

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
  /** An optional Privy app client for this web origin. */
  privyClientId: process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID?.trim() || undefined,
  /** 5042002 Arc testnet (the default), 5042 Arc mainnet, 31337 a local Hardhat node. */
  chainId: CHAIN_ID,
  /** Unset: the chain's public RPC (https://rpc.testnet.arc.io on Arc testnet). */
  rpcUrl: RPC_URL,
  /** A chain on this machine (a Hardhat node). */
  localChain: LOCAL_CHAIN,
  /** The block explorer. A local chain has none unless one is set. */
  explorerUrl: (process.env.NEXT_PUBLIC_EXPLORER_URL?.trim() || ARC_EXPLORERS[CHAIN_ID] || "").replace(/\/+$/, ""),
  /**
   * Polaris for Business, which runs the relayer (`/api/relay`) and serves
   * checkout sessions (`/api/public/sessions/{id}`), e.g. http://localhost:3100.
   * Required: unset, the app shows only that Polaris isn't configured on this
   * build, and nothing can be signed.
   */
  apiUrl: API_URL,
  contracts: {
    /**
     * Unset: the USDC Polaris for Business's deployment record reports
     * (network.ts): Circle's USDC on Arc (0x3600…0000), MockUSDC on a local
     * chain. Set, it pins this build: the app refuses to sign if the server
     * reports a different one.
     */
    usdc: address(process.env.NEXT_PUBLIC_USDC_ADDRESS),
    /** Circle's EURC: euro balances and euro send links. Unset: the one the deployment reports (none on a local chain). */
    eurc: address(process.env.NEXT_PUBLIC_EURC_ADDRESS),
    payments: address(process.env.NEXT_PUBLIC_PAYMENTS_ADDRESS),
    checkout: address(process.env.NEXT_PUBLIC_CHECKOUT_ADDRESS),
    send: address(process.env.NEXT_PUBLIC_SEND_ADDRESS),
    /** PolarisSend on EURC: send euros by link. Unset: the one the deployment reports (none: euro links aren't offered). */
    sendEurc: address(process.env.NEXT_PUBLIC_SEND_EURC_ADDRESS),
    /** PolarisSplit: split-the-bill links. Unset with Polaris configured: the one its deployment reports. */
    split: address(process.env.NEXT_PUBLIC_SPLIT_ADDRESS),
    loanEngine: address(process.env.NEXT_PUBLIC_LOAN_ENGINE_ADDRESS),
  },
} as const;

export type ContractName = keyof typeof env.contracts;
