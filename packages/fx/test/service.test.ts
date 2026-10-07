/**
 * The rates service against recorded feed answers: every JSON-RPC reply here
 * came from the public RPCs (test/fixtures/recorded-feeds.json, written by
 * `pnpm --filter @polaris/fx record`), replayed through viem, so the real
 * decode path runs. Outages and bad answers are made by editing the replay.
 */

import { readFileSync } from "node:fs";
import { custom, encodeAbiParameters, type Transport } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChainKey, FeedSource } from "../src/feeds.ts";
import { createFxService, FeedError, type FxServiceOptions, perUsdFromAnswer } from "../src/service.ts";
import { FX_FEEDS } from "../src/feeds.ts";
import { FX_MAX_AGE_SECONDS, sourceMaxAgeSeconds } from "../src/limits.ts";

type Call = { chain: ChainKey; method: string; to?: string; data?: string; result: string };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/recorded-feeds.json", import.meta.url), "utf8")) as {
  recordedAtMs: number;
  calls: Call[];
};

const DESCRIPTION = "0x7284e416";
const DECIMALS = "0x313ce567";
const LATEST_ROUND = "0xfeaf968c";

const ARS_ETHEREUM = "0xBb65fa58BDb7d33e4a3D1A40a7A9BD99E746367b";
const ARS_BASE = "0x9eb8a54d0590798880C665C7A6d51B95f4078Ad7";
/** When the recorded USD / ARS round on Ethereum was published. */
const ARS_UPDATED_AT = 1_790_543_663;

type Replay = {
  down?: Set<ChainKey>;
  /** Every answer waits for this first (a slow RPC). */
  hold?: Promise<void>;
  /** Replace one recorded answer: return a hex result, or undefined to keep the recording. */
  edit?: (chain: ChainKey, method: string, to?: string, data?: string) => string | undefined;
};

/** Counts every request that reached a "network", by chain and method. */
let requests: { chain: ChainKey; method: string; data?: string }[] = [];

function replay(opts: Replay = {}): FxServiceOptions["transport"] {
  return (chain: ChainKey): Transport =>
    custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const call = method === "eth_call" ? (params as [{ to: string; data: string }])[0] : undefined;
        requests.push({ chain, method, data: call?.data });
        if (opts.hold) await opts.hold;
        if (opts.down?.has(chain)) throw new Error(`${chain} RPC is down`);
        const edited = opts.edit?.(chain, method, call?.to, call?.data);
        if (edited !== undefined) return edited;
        const hit = fixture.calls.find(
          (c) => c.chain === chain && c.method === method && c.to?.toLowerCase() === call?.to.toLowerCase() && c.data === call?.data,
        );
        if (!hit) throw new Error(`nothing recorded for ${chain} ${method} ${call?.to} ${call?.data}`);
        return hit.result;
      },
    }, { retryCount: 0 });
}

function service(opts: Replay & Partial<FxServiceOptions> & { at?: () => number } = {}) {
  const errors: { source: FeedSource; error: unknown }[] = [];
  const s = createFxService({
    transport: replay(opts),
    now: opts.at ?? (() => fixture.recordedAtMs),
    onSourceError: (source, error) => errors.push({ source, error }),
    ...(opts.cacheMs !== undefined ? { cacheMs: opts.cacheMs } : {}),
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  return Object.assign(s, { errors });
}

const roundAnswer = (answer: bigint, updatedAt: bigint) =>
  encodeAbiParameters(
    [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
    [1n, answer, updatedAt, updatedAt, 1n],
  );

beforeEach(() => {
  requests = [];
});

describe("reading recorded Chainlink answers", () => {
  it("reads USD / ARS on Ethereum as pesos per dollar", async () => {
    const result = await service().lookup("ARS");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rate.perUsd).toBeCloseTo(1612.4065, 6);
    expect(result.rate).toMatchObject({
      currency: "ARS",
      updatedAt: ARS_UPDATED_AT,
      source: { chain: "ethereum", chainId: 1, address: ARS_ETHEREUM, pair: "USD / ARS", decimals: 8, roundId: "18446744073709551862" },
    });
  });

  it("inverts EUR / USD from Monad mainnet, 18 decimals", async () => {
    const result = await service().lookup("eur");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rate.perUsd).toBeCloseTo(1 / 1.138005, 9);
    expect(result.rate.source).toMatchObject({ chain: "monad", chainId: 143, pair: "EUR / USD", decimals: 18 });
    expect(result.rate.updatedAt).toBe(1_790_548_596);
  });

  it("reads PHP from Polygon (8 decimals) first", async () => {
    const result = await service().lookup("PHP");
    expect(result.status === "ok" && result.rate.source.chain).toBe("polygon");
    expect(result.status === "ok" && result.rate.perUsd).toBeCloseTo(1 / 0.01602212, 6);
  });

  it("answers every currency in the table from the recording", async () => {
    const s = service();
    for (const code of ["EUR", "GBP", "JPY", "CHF", "CAD", "ARS", "BRL", "MXN", "COP", "SEK", "PLN", "TRY", "PHP", "INR", "IDR", "THB", "SGD", "KRW", "CNY", "NGN", "ZAR", "AUD", "NZD"]) {
      const r = await s.lookup(code);
      expect(r.status, code).toBe("ok");
    }
    expect(s.errors).toEqual([]);
  });
});

describe("fallbacks", () => {
  it("uses Base's USD / ARS when Ethereum is down", async () => {
    const s = service({ down: new Set(["ethereum"]) });
    const result = await s.lookup("ARS");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rate.source).toMatchObject({ chain: "base", chainId: 8453, address: ARS_BASE });
    expect(result.rate.perUsd).toBeCloseTo(1612.4039, 6);
    expect(s.errors.map((e) => e.source.chain)).toEqual(["ethereum"]);
  });

  it("reads PHP / USD on Ethereum at 18 decimals when Polygon is down", async () => {
    const result = await service({ down: new Set(["polygon"]) }).lookup("PHP");
    expect(result.status === "ok" && result.rate.source).toMatchObject({ chain: "ethereum", decimals: 18 });
    expect(result.status === "ok" && result.rate.perUsd).toBeCloseTo(1 / 0.01603167859690749, 6);
  });

  it("refuses a feed whose description isn't the pair in the table", async () => {
    const s = service({
      edit: (chain, method, to, data) =>
        chain === "ethereum" && to?.toLowerCase() === ARS_ETHEREUM.toLowerCase() && data === DESCRIPTION
          ? encodeAbiParameters([{ type: "string" }], ["ARS / USD"])
          : undefined,
    });
    const result = await s.lookup("ARS");
    expect(result.status === "ok" && result.rate.source.chain).toBe("base");
    expect(String(s.errors[0]?.error)).toMatch(/is "ARS \/ USD", expected "USD \/ ARS"/);
  });

  it("refuses an RPC that is on another chain", async () => {
    const s = service({ edit: (chain, method) => (chain === "ethereum" && method === "eth_chainId" ? "0x2105" : undefined) });
    const result = await s.lookup("ARS");
    expect(result.status === "ok" && result.rate.source.chain).toBe("base");
    expect(String(s.errors[0]?.error)).toMatch(/on chain 8453, expected 1/);
  });

  it("refuses a zero answer, an unfinished round and a round from the future", async () => {
    const now = BigInt(Math.floor(fixture.recordedAtMs / 1000));
    for (const bad of [roundAnswer(0n, now), roundAnswer(-5n, now), roundAnswer(161240650000n, 0n), roundAnswer(161240650000n, now + 3600n)]) {
      const s = service({ edit: (_c, _m, _to, data) => (data === LATEST_ROUND ? bad : undefined), down: new Set() });
      expect((await s.lookup("ARS")).status).toBe("unavailable");
      expect(s.errors.every((e) => e.error instanceof FeedError)).toBe(true);
    }
  });

  it("is unavailable when no feed can be read", async () => {
    const result = await service({ down: new Set(["ethereum", "base"]) }).lookup("ARS");
    expect(result).toEqual({ currency: "ARS", status: "unavailable", rate: null });
  });
});

describe("the 26-hour limit", () => {
  it("still shows a rate exactly 26 h old", async () => {
    // Base's round is 12 s newer than Ethereum's; at 26 h after Ethereum's, both are within the limit.
    const result = await service({ at: () => (ARS_UPDATED_AT + 26 * 3600) * 1000 }).lookup("ARS");
    expect(result.status === "ok" && result.rate.source.chain).toBe("ethereum");
  });

  it("falls back past a stale feed, and is stale when every feed is", async () => {
    // Ethereum is 26 h + 1 s old; Base (12 s newer) is still inside.
    const edge = await service({ at: () => (ARS_UPDATED_AT + 26 * 3600 + 1) * 1000 }).lookup("ARS");
    expect(edge.status === "ok" && edge.rate.source.chain).toBe("base");

    const late = await service({ at: () => (ARS_UPDATED_AT + 27 * 3600) * 1000 }).lookup("ARS");
    expect(late).toEqual({ currency: "ARS", status: "stale", rate: null });
  });

  it("stops serving a cached rate once it ages past the limit", async () => {
    let now = (ARS_UPDATED_AT + 25 * 3600) * 1000;
    const s = service({ at: () => now, cacheMs: 48 * 3600 * 1000 });
    expect((await s.lookup("ARS")).status).toBe("ok");
    now = (ARS_UPDATED_AT + 27 * 3600) * 1000;
    expect((await s.lookup("ARS")).status).toBe("stale");
  });
});

describe("each feed's own heartbeat", () => {
  const EUR = FX_FEEDS.find((f) => f.currency === "EUR")!;
  const [monad, polygon] = EUR.sources;
  const nowS = Math.floor(fixture.recordedAtMs / 1000);
  const at = () => nowS * 1000;
  /** Monad's and Polygon's EUR / USD rounds, as the test sets them. */
  const eur = (monadAgo: number, polygonAgo: number) =>
    service({
      at,
      edit: (chain, method, to, data) => {
        if (method !== "eth_call" || data !== LATEST_ROUND) return undefined;
        if (chain === "monad" && to?.toLowerCase() === monad!.address.toLowerCase()) return roundAnswer(1_170_000_000_000_000_000n, BigInt(nowS - monadAgo));
        // Polygon's rate is 5% off Monad's, so the test can tell which one was served.
        if (chain === "polygon" && to?.toLowerCase() === polygon!.address.toLowerCase()) return roundAnswer(122_850_000n, BigInt(nowS - polygonAgo));
        return undefined;
      },
    });

  it("gives each source twice its heartbeat, or its heartbeat plus 10 min, never past 26 h", () => {
    expect(monad).toMatchObject({ chain: "monad", heartbeatSeconds: 240 });
    expect(sourceMaxAgeSeconds(monad!)).toBe(240 + 600);
    expect(sourceMaxAgeSeconds(polygon!)).toBe(27 + 600);
    expect(sourceMaxAgeSeconds({ heartbeatSeconds: 86_400 })).toBe(FX_MAX_AGE_SECONDS);
    expect(sourceMaxAgeSeconds({ heartbeatSeconds: 3_600 })).toBe(7_200);
    expect(sourceMaxAgeSeconds({ heartbeatSeconds: 3_600 }, 1_800)).toBe(1_800);
  });

  // Security review (fx-staleness): a stopped 240 s Monad feed was served as
  // "ok" for up to 26 h, and the fresher Polygon fallback was never read.
  it("a Monad feed 25 h old is stale: the fresh Polygon fallback is read and served", async () => {
    const s = eur(25 * 3600, 10);
    const result = await s.lookup("EUR");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rate.source.chain).toBe("polygon");
    expect(result.rate.perUsd).toBeCloseTo(1 / 1.2285, 10);
    expect(result.rate.maxAgeSeconds).toBe(627);
    expect(s.errors.map((e) => [e.source.chain, String(e.error)])).toEqual([["monad", expect.stringContaining("stale")]]);
  });

  it("a Monad feed a few minutes late is still Monad's; both stopped is stale", async () => {
    const late = await eur(10 * 60, 10).lookup("EUR");
    expect(late.status === "ok" && late.rate.source.chain).toBe("monad");
    expect(await eur(20 * 60, 20 * 60).lookup("EUR")).toEqual({ currency: "EUR", status: "stale", rate: null });
  });

  it("stops serving a cached rate once it ages past its own source's limit", async () => {
    let now = nowS * 1000;
    const s = createFxService({
      transport: replay({
        edit: (chain, method, to, data) =>
          chain === "monad" && method === "eth_call" && data === LATEST_ROUND && to?.toLowerCase() === monad!.address.toLowerCase()
            ? roundAnswer(1_170_000_000_000_000_000n, BigInt(nowS - 60))
            : undefined,
      }),
      now: () => now,
      cacheMs: 48 * 3600 * 1000,
    });
    expect((await s.lookup("EUR")).status).toBe("ok");
    now = (nowS + 900) * 1000; // 16 min after its update: past Monad's 14 min
    expect((await s.lookup("EUR")).status).toBe("stale");
  });
});

describe("caching", () => {
  it("reads each feed once per five minutes, and checks the chain and pair only once", async () => {
    let now = fixture.recordedAtMs;
    const s = service({ at: () => now });
    await s.lookup("ARS");
    const first = requests.length;
    expect(requests.map((r) => r.data ?? r.method).sort()).toEqual([DECIMALS, DESCRIPTION, "eth_chainId", LATEST_ROUND].sort());

    now += 4 * 60 * 1000;
    await s.lookup("ARS");
    expect(requests.length).toBe(first);

    now += 60 * 1000 + 1;
    await s.lookup("ARS");
    expect(requests.slice(first).map((r) => r.data).sort()).toEqual([DECIMALS, LATEST_ROUND].sort());
  });

  it("shares one read between lookups made at the same time", async () => {
    const s = service();
    const [a, b, c] = await Promise.all([s.lookup("ARS"), s.lookup("ars"), s.lookup(" ARS ")]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(requests.filter((r) => r.data === LATEST_ROUND)).toHaveLength(1);
  });

  it("retries a failed lookup after 30 seconds, not five minutes", async () => {
    let now = fixture.recordedAtMs;
    const down = new Set<ChainKey>(["ethereum", "base"]);
    const s = service({ at: () => now, down });
    expect((await s.lookup("ARS")).status).toBe("unavailable");
    down.clear();
    now += 20 * 1000;
    expect((await s.lookup("ARS")).status).toBe("unavailable");
    now += 11 * 1000;
    expect((await s.lookup("ARS")).status).toBe("ok");
  });

  it("answers a slow lookup as unavailable by the deadline, and caches the late answer", async () => {
    let release!: () => void;
    const s = service({ hold: new Promise<void>((r) => (release = r)), deadlineMs: 30 });
    const started = Date.now();
    expect(await s.lookup("ARS")).toEqual({ currency: "ARS", status: "unavailable", rate: null });
    expect(Date.now() - started).toBeLessThan(1000);
    release();
    await new Promise((r) => setTimeout(r, 20));
    const reads = requests.length;
    const late = await s.lookup("ARS");
    expect(late.status === "ok" && late.rate.source.chain).toBe("ethereum");
    expect(requests.length).toBe(reads);
  });

  it("answers no-feed for currencies without one, without touching the network", async () => {
    const s = service();
    expect(await s.lookup("CLP")).toEqual({ currency: "CLP", status: "no-feed", rate: null });
    expect(await s.lookup("USD")).toEqual({ currency: "USD", status: "no-feed", rate: null });
    expect(await s.lookup("XYZ")).toEqual({ currency: "XYZ", status: "no-feed", rate: null });
    expect(requests).toEqual([]);
  });
});

describe("configuration", () => {
  it("takes RPC endpoints from FX_RPC_<CHAIN>, else the public ones", async () => {
    const seen = new Map<ChainKey, readonly string[]>();
    const inner = replay();
    const s = createFxService({
      env: { FX_RPC_ETHEREUM: " https://eth.example/a , https://eth.example/b " },
      now: () => fixture.recordedAtMs,
      transport: (chain, urls) => {
        seen.set(chain, urls);
        return inner!(chain, urls);
      },
    });
    await s.lookup("ARS");
    await s.lookup("EUR");
    expect(seen.get("ethereum")).toEqual(["https://eth.example/a", "https://eth.example/b"]);
    expect(seen.get("monad")).toEqual(["https://rpc.monad.xyz", "https://rpc1.monad.xyz"]);
  });
});

describe("perUsdFromAnswer", () => {
  it("normalises decimals and the direction of the pair", () => {
    expect(perUsdFromAnswer(161240650000n, 8, "USD / ARS")).toBeCloseTo(1612.4065, 9);
    expect(perUsdFromAnswer(1138005000000000000n, 18, "EUR / USD")).toBeCloseTo(0.8787307613, 9);
    expect(perUsdFromAnswer(5580n, 8, "IDR / USD")).toBeCloseTo(17921.146953, 5);
  });

  it("refuses a non-positive answer", () => {
    expect(() => perUsdFromAnswer(0n, 8, "USD / ARS")).toThrow(FeedError);
  });
});
