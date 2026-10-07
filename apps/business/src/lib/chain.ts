import { getAddress, isAddress } from "viem";
import { arc, arcTestnet } from "viem/chains";

import type { Address } from "./data/types";

/**
 * Arc, as the dashboard uses it. viem ships both chains: Arc testnet
 * (5042002) is the default unless NEXT_PUBLIC_CHAIN_ID=5042 picks mainnet;
 * both are configured so a merchant's wallet already knows them. Gas on
 * either is USDC.
 */
const MAINNET = process.env.NEXT_PUBLIC_CHAIN_ID === String(arc.id);
export const DEFAULT_CHAIN = MAINNET ? arc : arcTestnet;
export const SUPPORTED_CHAINS = MAINNET ? ([arc, arcTestnet] as const) : ([arcTestnet, arc] as const);

/** Arc's explorers (Blockscout): viem's entry predates the arc.io explorer domains. */
const EXPLORER = (process.env.NEXT_PUBLIC_EXPLORER_URL || (MAINNET ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io")).replace(/\/+$/, "");

export function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

/* ── USDC and its ERC-3009 authorisations ───────────────────────────────── */

/** USDC has 6 decimals; the dashboard counts cents. */
export const USDC_DECIMALS = 6;
export const CENTS_TO_USDC_UNITS = 10n ** BigInt(USDC_DECIMALS - 2);

function usdcAddress(): Address | null {
  const raw = process.env.NEXT_PUBLIC_USDC_ADDRESS;
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

/**
 * The EIP-712 domain for USDC transfers from this build's environment, or
 * null when it isn't set (`networkUsdcDomain` then reads it from the server).
 * USDC on Arc has no `eip712Domain()`: its domain is name "USDC", version "2"
 * (checked against DOMAIN_SEPARATOR() by the deploy script).
 */
export function usdcDomain() {
  const verifyingContract = usdcAddress();
  if (!verifyingContract) return null;
  return {
    name: process.env.NEXT_PUBLIC_USDC_EIP712_NAME || "USDC",
    version: process.env.NEXT_PUBLIC_USDC_EIP712_VERSION || "2",
    chainId: DEFAULT_CHAIN.id,
    verifyingContract,
  } as const;
}

/** Circle's ERC-3009 TransferWithAuthorization. Field order matters: it is part of the type hash. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** How long a withdrawal signature stays valid. */
export const AUTHORIZATION_TTL_SECONDS = 60 * 60;
