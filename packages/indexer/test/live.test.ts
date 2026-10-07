/**
 * The whole indexer, end to end, with no Docker: Envio's own runtime reads a
 * live local chain over RPC (dynamic merchant registration, the wildcard
 * transfer filter and all), and the indexed state must equal what the
 * contracts report. Run by scripts/live.sh, which starts the chain, records
 * the expected state and points config.yaml at it; skipped otherwise.
 */

import { readFileSync } from "node:fs";

import { createTestIndexer, type TestIndexer } from "envio";
import { beforeAll, describe, expect } from "vitest";

import { DEPLOYMENTS } from "../src/deployment.js";
import { chainChecks, type Fixture } from "./chain-checks.js";

const FIXTURE = process.env.POLARIS_LIVE_FIXTURE;

describe.skipIf(!FIXTURE)("indexing a live local chain over RPC", () => {
  const fixture = FIXTURE ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture) : (undefined as never);
  let indexer: TestIndexer;

  beforeAll(async () => {
    const chainId = fixture.chainId;
    const settings = DEPLOYMENTS[chainId];
    if (!settings) throw new Error(`config.yaml is not generated for chain ${chainId}: run scripts/live.sh`);
    const endBlock = Math.max(...fixture.events.map((e) => e.blockNumber));
    indexer = createTestIndexer();
    await indexer.process({ chains: { [chainId]: { startBlock: settings.startBlock, endBlock } } } as never);
    expect((await indexer.Payment.getAll()).length).toBeGreaterThan(0);
  }, 300_000);

  chainChecks(() => indexer, fixture);
});
