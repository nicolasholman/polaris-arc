import { type Chain, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { env } from "./env";

export const chain: Chain = env.chainId === monad.id ? monad : monadTestnet;

let client: PublicClient | undefined;

/** One read-only client for the session. The app never sends transactions. */
export function publicClient(): PublicClient {
  client ??= createPublicClient({ chain, transport: http(env.rpcUrl) });
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
