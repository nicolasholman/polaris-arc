import { getAddress, isAddress } from "viem";
import { monad, monadTestnet } from "viem/chains";

import type { Address } from "./data/types";

/**
 * Monad, as the dashboard uses it. viem 2.56 ships both chains: `monadTestnet`
 * (10143) is the default; mainnet (143) is configured so a merchant's wallet
 * already knows it.
 */
export const DEFAULT_CHAIN = monadTestnet;
export const SUPPORTED_CHAINS = [monadTestnet, monad] as const;

export function explorerTx(hash: string): string {
  return `${DEFAULT_CHAIN.blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${DEFAULT_CHAIN.blockExplorers.default.url}/address/${address}`;
}

/* ── AUSD and its ERC-3009 authorisations ───────────────────────────────── */

/** AUSD has 6 decimals; the dashboard counts cents. */
export const AUSD_DECIMALS = 6;
export const CENTS_TO_AUSD_UNITS = 10n ** BigInt(AUSD_DECIMALS - 2);

function ausdAddress(): Address | null {
  const raw = process.env.NEXT_PUBLIC_AUSD_ADDRESS;
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

/**
 * The EIP-712 domain for AUSD transfers from this build's environment, or
 * null when it isn't set (`networkAusdDomain` then reads it from the server).
 * The name and version must match AUSD's `eip712Domain()`.
 */
export function ausdDomain() {
  const verifyingContract = ausdAddress();
  if (!verifyingContract) return null;
  return {
    // AUSD's EIP-712 name is "Agora Dollar", not its ERC-20 name (docs/research/ausd.md §4.2).
    name: process.env.NEXT_PUBLIC_AUSD_EIP712_NAME || "Agora Dollar",
    version: process.env.NEXT_PUBLIC_AUSD_EIP712_VERSION || "1",
    chainId: DEFAULT_CHAIN.id,
    verifyingContract,
  } as const;
}

/** From AUSD's Eip3009.sol. Field order matters: it is part of the type hash. */
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
