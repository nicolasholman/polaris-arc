import "server-only";

import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";

import { getConfig, type ChainConfig } from "../env";

/**
 * One read client per process for the configured chain. Monad makes a block
 * every 400 ms, so receipts are polled every 250 ms.
 */

let cached: { key: string; client: PublicClient; chain: Chain } | null = null;

export function viemChain(config: ChainConfig): Chain {
  return defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: config.explorerUrl ? { default: { name: "Explorer", url: config.explorerUrl } } : undefined,
    testnet: config.id !== 143,
  });
}

export function requireChain(): ChainConfig {
  const { chain, chainProblem } = getConfig();
  if (!chain) throw new ChainNotConfigured(chainProblem ?? "No chain is configured.");
  return chain;
}

export class ChainNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainNotConfigured";
  }
}

let override: PublicClient | null = null;

/** Tests only: answer chain reads and writes from a fake. Refused in production. */
export function setPublicClientForTests(client: unknown): void {
  if (process.env.NODE_ENV === "production") throw new Error("Not in production.");
  override = client as PublicClient | null;
}

export function publicClient(): PublicClient {
  const config = requireChain();
  if (override) return override;
  const key = `${config.id}:${config.rpcUrl}`;
  if (!cached || cached.key !== key) {
    const chain = viemChain(config);
    cached = {
      key,
      chain,
      client: createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 2, timeout: 15_000 }), pollingInterval: 250 }) as PublicClient,
    };
  }
  return cached.client;
}

let logsCached: { key: string; client: PublicClient } | null = null;

/**
 * The client the chain sync reads logs with: Envio's HyperRPC when
 * POLARIS_LOGS_RPC_URL is set (the same JSON-RPC, answered from Envio's
 * index, with no 100-block cap), else the chain's own RPC.
 */
export function logsClient(): PublicClient {
  const config = requireChain();
  if (!config.logsRpcUrl) return publicClient();
  const key = `${config.id}:${config.logsRpcUrl}`;
  if (!logsCached || logsCached.key !== key) {
    logsCached = {
      key,
      client: createPublicClient({ chain: viemChain(config), transport: http(config.logsRpcUrl, { retryCount: 2, timeout: 30_000 }) }) as PublicClient,
    };
  }
  return logsCached.client;
}

export function resetClientForTests(): void {
  cached = null;
  logsCached = null;
  override = null;
}
