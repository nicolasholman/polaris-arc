import "server-only";

import { createPublicClient, http, parseAbi, type Address } from "viem";

/**
 * Chainlink Data Feeds on Arc mainnet, read for what they mean to Polaris:
 * EURC / USD (what a euro send link is worth in dollars), EUR / USD (the
 * reference rate it tracks) and USDC / USD (the peg CreditGuard watches).
 * Read from Arc mainnet whatever network this server runs on (testnet has no
 * feeds): reads only, cached five minutes, never used to price or settle.
 */

const FEEDS: Record<"eurcUsd" | "eurUsd" | "usdcUsd", Address> = {
  eurcUsd: "0x361b95c10b76Ca3f35C686d423e43A951755Bf23",
  eurUsd: "0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D",
  usdcUsd: "0x84EA90AC252Dc437031461836DB5164219147905",
};
const ABI = parseAbi(["function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)"]);
const TTL_MS = 5 * 60_000;
/** A 24 h heartbeat, with an hour of slack. */
const MAX_AGE_S = 25 * 3600;

export type ArcRate = { pair: string; feed: Address; price: string; updatedAt: string; stale: boolean };
export type ArcRates = { source: "Chainlink Data Feeds on Arc mainnet"; eurcUsd: ArcRate | null; eurUsd: ArcRate | null; usdcUsd: ArcRate | null };

let cache: { at: number; value: Promise<ArcRates> } | null = null;

async function read(): Promise<ArcRates> {
  const client = createPublicClient({ transport: http(process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io", { timeout: 8_000 }) });
  const now = Math.floor(Date.now() / 1000);
  const one = async (key: keyof typeof FEEDS, pair: string): Promise<ArcRate | null> => {
    try {
      const [, answer, , updatedAt] = (await client.readContract({ address: FEEDS[key], abi: ABI, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
      if (answer <= 0n) return null;
      return { pair, feed: FEEDS[key], price: (Number(answer) / 1e8).toFixed(6), updatedAt: new Date(Number(updatedAt) * 1000).toISOString(), stale: now - Number(updatedAt) > MAX_AGE_S };
    } catch {
      return null;
    }
  };
  const [eurcUsd, eurUsd, usdcUsd] = await Promise.all([one("eurcUsd", "EURC / USD"), one("eurUsd", "EUR / USD"), one("usdcUsd", "USDC / USD")]);
  return { source: "Chainlink Data Feeds on Arc mainnet", eurcUsd, eurUsd, usdcUsd };
}

export function arcRates(): Promise<ArcRates> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = read();
  cache = { at: Date.now(), value };
  return value;
}
