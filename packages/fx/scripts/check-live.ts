/**
 * The live read check: reads every feed in the table from today's chains,
 * through the same service the apps use, and prints what each one says.
 *
 *   pnpm --filter @polaris/fx check:live            # read and report
 *   pnpm --filter @polaris/fx record                # also rewrite test/fixtures/recorded-feeds.json
 *
 * Needs outbound HTTPS to the public RPCs in `CHAINS` (or FX_RPC_<CHAIN>).
 * Exits 1 when a feed's description or decimals no longer match the table,
 * or when a currency has no fresh rate from any of its feeds.
 */

import { writeFileSync } from "node:fs";
import { custom, type Transport } from "viem";
import { CHAINS, type ChainKey, FX_FEEDS, NO_FEED } from "../src/feeds.ts";
import { createFxService, type FxLookup } from "../src/service.ts";

const RECORD = process.argv.includes("--record");
const FIXTURE = new URL("../test/fixtures/recorded-feeds.json", import.meta.url);

type Recorded = { chain: ChainKey; method: string; to?: string; data?: string; result: unknown };
const recorded: Recorded[] = [];
const seen = new Set<string>();

/** Plain JSON-RPC over fetch, keeping every answer for the fixture. */
function recordingTransport(chain: ChainKey, urls: readonly string[]): Transport {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      let last: unknown;
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
            signal: AbortSignal.timeout(10_000),
          });
          const body = (await res.json()) as { result?: unknown; error?: { message: string } };
          if (body.error) throw new Error(body.error.message);
          const call = method === "eth_call" ? (params as [{ to: string; data: string }])[0] : undefined;
          // First answer wins, so the fixture is one consistent snapshot.
          const key = `${chain}:${method}:${call?.to?.toLowerCase() ?? ""}:${call?.data ?? ""}`;
          if (!seen.has(key)) {
            seen.add(key);
            recorded.push({ chain, method, to: call?.to, data: call?.data, result: body.result });
          }
          return body.result;
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
  });
}

const errors = new Map<string, string>();
const transport = RECORD ? recordingTransport : undefined;
const rows: string[][] = [];
let failed = false;

const pad = (cells: string[], widths: number[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
const ageText = (updatedAt: number) => {
  const s = Date.now() / 1000 - updatedAt;
  return s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

for (const feeds of FX_FEEDS) {
  for (const source of feeds.sources) {
    // One service per source, so every feed is read (not just the first that works).
    const service = createFxService({
      feeds: [{ ...feeds, sources: [source] }],
      transport,
      onSourceError: (_s, error) => errors.set(source.address, error instanceof Error ? error.message.split("\n")[0]! : String(error)),
    });
    const result: FxLookup = await service.lookup(feeds.currency);
    let verdict: string;
    if (result.status === "ok") {
      const { rate } = result;
      const decimalsOk = rate.source.decimals === source.decimals;
      const overdue = Date.now() / 1000 - rate.updatedAt > source.heartbeatSeconds * 1.1 + 120;
      verdict = !decimalsOk ? `DECIMALS ${rate.source.decimals} != ${source.decimals}` : overdue ? "ok (past heartbeat)" : "ok";
      if (!decimalsOk) failed = true;
      rows.push([feeds.currency, CHAINS[source.chain].name, source.address, source.pair, String(rate.source.decimals), rate.perUsd.toPrecision(7), ageText(rate.updatedAt), verdict]);
    } else {
      verdict = `${result.status.toUpperCase()}: ${errors.get(source.address) ?? ""}`;
      if (result.status === "unavailable") failed = true;
      rows.push([feeds.currency, CHAINS[source.chain].name, source.address, source.pair, "-", "-", "-", verdict]);
    }
  }
}

const header = ["Currency", "Chain", "Feed", "Pair", "Dec", "Per USD", "Age", "Check"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
console.log(pad(header, widths));
for (const row of rows) console.log(pad(row, widths));

// What the apps would show: each currency through the full table, fallbacks included.
const service = createFxService({ transport });
console.log("\nWhat /api/fx returns:");
for (const { currency } of FX_FEEDS) {
  const r = await service.lookup(currency);
  if (r.status !== "ok") failed = true;
  console.log(
    `  ${currency}  ${r.status === "ok" ? `${r.rate.perUsd.toPrecision(7).padStart(12)} per USD  from ${CHAINS[r.rate.source.chain].name} ${r.rate.source.pair}, ${ageText(r.rate.updatedAt)} old` : r.status}`,
  );
}
console.log(`  No feed (line hidden): ${NO_FEED.join(", ")}`);

if (RECORD) {
  const recordedAtMs = Date.now();
  const fixture = {
    note: "Raw JSON-RPC answers from the public RPCs, recorded by `pnpm --filter @polaris/fx record`. The tests replay them.",
    recordedAt: new Date(recordedAtMs).toISOString(),
    recordedAtMs,
    calls: recorded,
  };
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`\nRecorded ${recorded.length} answers to ${FIXTURE.pathname}`);
}

if (failed) {
  console.error("\nFAILED: a feed no longer matches the table, or a currency has no fresh rate.");
  process.exit(1);
}
console.log("\nAll feeds match the table and every currency has a fresh rate.");
