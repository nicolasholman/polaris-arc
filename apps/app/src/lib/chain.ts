import { type Chain, createPublicClient, defineChain, type Hex, http, type PublicClient } from "viem";
import { arc, arcTestnet } from "viem/chains";
import { ARC_MAINNET, ARC_TESTNET, env } from "./env";

/**
 * Arc: gas is USDC (the native balance, 18 decimals, is the same money the
 * USDC ERC-20 at 0x3600…0000 shows in 6), and a block is final in under a
 * second. The app reads the chain and never sends to it: the relayer pays the
 * gas. A local Hardhat node (31337) stands in for it in development.
 */
function arcChain(): Chain {
  const base = env.chainId === ARC_MAINNET ? arc : env.chainId === ARC_TESTNET ? arcTestnet : null;
  const rpc = env.rpcUrl ?? (env.chainId === ARC_MAINNET ? "https://rpc.mainnet.arc.io" : env.chainId === ARC_TESTNET ? "https://rpc.testnet.arc.io" : "http://127.0.0.1:8600");
  const explorer = env.explorerUrl ? { default: { name: "Arc Explorer", url: env.explorerUrl } } : undefined;
  if (base) return { ...base, rpcUrls: { default: { http: [rpc] } }, ...(explorer ? { blockExplorers: explorer } : {}) };
  return defineChain({
    id: env.chainId,
    name: "Local chain",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    ...(explorer ? { blockExplorers: explorer } : {}),
    testnet: true,
  });
}

export const chain: Chain = arcChain();

let client: PublicClient | undefined;

/** One read-only client for the session. The app never sends transactions on Arc. */
export function publicClient(): PublicClient {
  client ??= createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
  return client;
}

/**
 * "View receipt" is the only place the buyer ever meets the explorer. Null
 * on a local chain with no explorer.
 */
export function receiptUrl(txHash: Hex): string | null {
  if (!env.explorerUrl) return null;
  return `${env.explorerUrl}/tx/${txHash}`;
}
