/**
 * The rates service: reads Chainlink FX feeds with viem, on the server.
 *
 * One lookup reads the feed's `latestRoundData()` and `decimals()` (and, the
 * first time, `description()` to prove the address is the pair we think it
 * is), turns the answer into "local currency per US dollar", and keeps it for
 * a few minutes. A rate older than 26 hours counts as missing: Ethereum's FX
 * feeds have a 24 h heartbeat, so anything older means the feed has stopped.
 */

import {
  type Address,
  createPublicClient,
  fallback,
  formatUnits,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { CHAINS, type ChainKey, type CurrencyFeeds, FX_FEEDS, type FeedSource, quotesLocalPerUsd } from "./feeds.ts";
import { FX_CACHE_MS, FX_ERROR_CACHE_MS, FX_MAX_AGE_SECONDS, sourceMaxAgeSeconds } from "./limits.ts";

export interface FxRate {
  /** ISO 4217 code of the local currency. */
  currency: string;
  /** Local currency units per one US dollar, e.g. 1612.4065 for ARS. */
  perUsd: number;
  /** When the feed last updated, in unix seconds (`latestRoundData().updatedAt`). */
  updatedAt: number;
  /**
   * How old this feed's rate may get before it counts as stale: its own
   * heartbeat's limit (limits.ts `sourceMaxAgeSeconds`), at most 26 h.
   */
  maxAgeSeconds: number;
  /** The feed the rate came from. */
  source: {
    chain: ChainKey;
    chainId: number;
    address: Address;
    /** The feed's `description()`, e.g. "USD / ARS". */
    pair: string;
    decimals: number;
    /** `latestRoundData().roundId`, as a decimal string (it doesn't fit a JS number). */
    roundId: string;
  };
}

/**
 * What a lookup found. Only `ok` carries a rate; the others say why there is
 * none, and the app shows no local amount for any of them.
 *
 * - `no-feed`: Chainlink has no feed for this currency (or it is USD).
 * - `stale`: every feed answered, but each one's update is older than its own
 *   limit (twice its heartbeat, or its heartbeat plus 10 min; at most 26 h).
 * - `unavailable`: no feed could be read (RPC down, wrong chain, bad answer).
 */
export type FxLookup =
  | { currency: string; status: "ok"; rate: FxRate }
  | { currency: string; status: "no-feed" | "stale" | "unavailable"; rate: null };

export interface FxServiceOptions {
  /** RPC endpoints per chain. Default: `FX_RPC_<CHAIN>` from `env` if set, else the public ones in `CHAINS`. */
  rpcUrls?: Partial<Record<ChainKey, readonly string[]>>;
  /** Where `FX_RPC_<CHAIN>` overrides are read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Builds the transport for a chain. Tests pass one that replays recorded answers. */
  transport?: (chain: ChainKey, urls: readonly string[]) => Transport;
  /** The clock, in milliseconds. */
  now?: () => number;
  cacheMs?: number;
  errorCacheMs?: number;
  maxAgeSeconds?: number;
  /** Per-request RPC timeout (default 5 s). */
  timeoutMs?: number;
  /**
   * The longest a caller waits (default 10 s). Past it the lookup answers
   * `unavailable`, while the read carries on and fills the cache for the next
   * caller, so one slow RPC never holds a page's request open.
   */
  deadlineMs?: number;
  /** The feed table. Default `FX_FEEDS`. */
  feeds?: readonly CurrencyFeeds[];
  /** Told about every feed that could not be used, e.g. to log it. */
  onSourceError?: (source: FeedSource, error: unknown) => void;
}

export interface FxService {
  lookup(currency: string): Promise<FxLookup>;
  /** Forgets every cached rate and verified feed (tests, or after changing RPCs). */
  clear(): void;
}

const AGGREGATOR_V3_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** A feed answered, but not with something we can use. */
export class FeedError extends Error {
  override name = "FeedError";
}

/** Clock skew tolerated for an `updatedAt` slightly ahead of our clock. */
const FUTURE_SKEW_SECONDS = 5 * 60;

/**
 * Local-per-dollar from a raw answer. `formatUnits` is exact; the one float
 * division after it keeps ~15 significant digits, far more than a display needs.
 */
export function perUsdFromAnswer(answer: bigint, decimals: number, pair: string): number {
  if (answer <= 0n) throw new FeedError(`non-positive answer ${answer}`);
  const value = Number(formatUnits(answer, decimals));
  return quotesLocalPerUsd(pair) ? value : 1 / value;
}

function defaultTransport(_chain: ChainKey, urls: readonly string[], timeoutMs: number): Transport {
  const transports = urls.map((url) => http(url, { timeout: timeoutMs, retryCount: 0 }));
  return transports.length === 1 ? transports[0]! : fallback(transports, { retryCount: 0 });
}

function urlsFor(chain: ChainKey, options: FxServiceOptions): readonly string[] {
  const configured = options.rpcUrls?.[chain];
  if (configured?.length) return configured;
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
  const fromEnv = env[CHAINS[chain].envVar]
    ?.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return fromEnv?.length ? fromEnv : CHAINS[chain].rpcUrls;
}

export function createFxService(options: FxServiceOptions = {}): FxService {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? FX_CACHE_MS;
  const errorCacheMs = options.errorCacheMs ?? FX_ERROR_CACHE_MS;
  const maxAgeSeconds = options.maxAgeSeconds ?? FX_MAX_AGE_SECONDS;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadlineMs = options.deadlineMs ?? 10_000;
  const table = new Map((options.feeds ?? FX_FEEDS).map((f) => [f.currency, f]));

  const clients = new Map<ChainKey, PublicClient>();
  /** Chains whose RPC answered with the right chain id (checked once). */
  const checkedChains = new Map<string, Promise<void>>();
  /** Feeds whose `description()` matched the table (checked once). */
  const verifiedFeeds = new Map<string, Promise<void>>();
  const cache = new Map<string, { result: FxLookup; expiresAt: number }>();
  const inflight = new Map<string, Promise<FxLookup>>();

  function client(chain: ChainKey): PublicClient {
    let c = clients.get(chain);
    if (!c) {
      const urls = urlsFor(chain, options);
      const transport = options.transport ? options.transport(chain, urls) : defaultTransport(chain, urls, timeoutMs);
      c = createPublicClient({ transport }) as PublicClient;
      clients.set(chain, c);
    }
    return c;
  }

  /** Runs `check` once per key; a failure is forgotten so the next lookup tries again. */
  function once(map: Map<string, Promise<void>>, key: string, check: () => Promise<void>): Promise<void> {
    let p = map.get(key);
    if (!p) {
      p = check();
      map.set(key, p);
      p.catch(() => map.delete(key));
    }
    return p;
  }

  async function read(source: FeedSource, currency: string): Promise<FxRate> {
    const limit = sourceMaxAgeSeconds(source, maxAgeSeconds);
    const c = client(source.chain);
    const chainId = CHAINS[source.chain].id;
    await once(checkedChains, source.chain, async () => {
      const got = await c.getChainId();
      if (got !== chainId) throw new FeedError(`${source.chain} RPC is on chain ${got}, expected ${chainId}`);
    });
    await once(verifiedFeeds, `${source.chain}:${source.address}`, async () => {
      const description = await c.readContract({ address: source.address, abi: AGGREGATOR_V3_ABI, functionName: "description" });
      if (description !== source.pair) throw new FeedError(`${source.address} is "${description}", expected "${source.pair}"`);
    });
    const [decimals, round] = await Promise.all([
      c.readContract({ address: source.address, abi: AGGREGATOR_V3_ABI, functionName: "decimals" }),
      c.readContract({ address: source.address, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }),
    ]);
    const [roundId, answer, , updatedAt] = round;
    if (updatedAt === 0n) throw new FeedError("round not complete (updatedAt 0)");
    const updated = Number(updatedAt);
    if (updated > now() / 1000 + FUTURE_SKEW_SECONDS) throw new FeedError(`updatedAt ${updated} is in the future`);
    return {
      currency,
      perUsd: perUsdFromAnswer(answer, decimals, source.pair),
      updatedAt: updated,
      maxAgeSeconds: limit,
      source: { chain: source.chain, chainId, address: source.address, pair: source.pair, decimals, roundId: roundId.toString() },
    };
  }

  /** Within its own source's limit (a rate from before `maxAgeSeconds` existed on it: the overall cap). */
  const isFresh = (rate: FxRate) => now() / 1000 - rate.updatedAt <= Math.min(rate.maxAgeSeconds ?? maxAgeSeconds, maxAgeSeconds);

  async function resolve(feeds: CurrencyFeeds): Promise<FxLookup> {
    let sawStale = false;
    for (const source of feeds.sources) {
      try {
        const rate = await read(source, feeds.currency);
        if (isFresh(rate)) return { currency: feeds.currency, status: "ok", rate };
        sawStale = true;
        options.onSourceError?.(source, new FeedError(`stale: updated ${rate.updatedAt}`));
      } catch (error) {
        options.onSourceError?.(source, error);
      }
    }
    return { currency: feeds.currency, status: sawStale ? "stale" : "unavailable", rate: null };
  }

  return {
    async lookup(input) {
      const currency = input.trim().toUpperCase();
      const feeds = table.get(currency);
      if (!feeds) return { currency, status: "no-feed", rate: null };

      const hit = cache.get(currency);
      if (hit && hit.expiresAt > now()) {
        // A cached rate can age past the limit while it sits here.
        if (hit.result.status === "ok" && !isFresh(hit.result.rate)) return { currency, status: "stale", rate: null };
        return hit.result;
      }

      let pending = inflight.get(currency);
      if (!pending) {
        pending = resolve(feeds).then((result) => {
          cache.set(currency, { result, expiresAt: now() + (result.status === "unavailable" ? errorCacheMs : cacheMs) });
          return result;
        });
        inflight.set(currency, pending);
        pending.finally(() => inflight.delete(currency)).catch(() => undefined);
      }
      // Answer by the deadline; a slower read still lands in the cache.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<FxLookup>((done) => {
        timer = setTimeout(() => done({ currency, status: "unavailable", rate: null }), deadlineMs);
      });
      return Promise.race([pending, late]).finally(() => clearTimeout(timer));
    },
    clear() {
      cache.clear();
      inflight.clear();
      checkedChains.clear();
      verifiedFeeds.clear();
      clients.clear();
    },
  };
}
