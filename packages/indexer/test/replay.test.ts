/**
 * Replay a real chain through the real handlers.
 *
 * test/fixtures/local-chain.json is recorded by scripts/record-fixture.mjs: a
 * local Hardhat chain running the deploy script, the contracts' end-to-end
 * flows and scripts/fixture-scenarios.cjs (a failed collection, a
 * liquidation with seized collateral, payouts, a quoted order, cancellations,
 * a batch). Its logs are replayed here at the configured addresses, and the
 * indexed state must equal what the contracts themselves report.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect } from "vitest";

import { chainChecks, type Fixture } from "./chain-checks.js";
import { A, CHAIN, SETTINGS, Sim } from "./sim.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "local-chain.json"), "utf8")) as Fixture;

/** The fixture's contract names as config.yaml knows them, with their ABI file and configured address. */
const RENAME: Record<string, { contract: string; abi: string; address: string }> = {
  ScoreManager: { contract: "ScoreManager", abi: "ScoreManager", address: A.ScoreManager },
  PolarisLoanEngine: { contract: "PolarisLoanEngine", abi: "PolarisLoanEngine", address: A.PolarisLoanEngine },
  PolarisPayments: { contract: "PolarisPayments", abi: "PolarisPayments", address: A.PolarisPayments },
  MerchantRegistry: { contract: "MerchantRegistry", abi: "MerchantRegistry", address: A.MerchantRegistry },
  CollateralVault: { contract: "CollateralVault", abi: "CollateralVault", address: A.CollateralVault },
  BatchSettlement: { contract: "BatchSettlement", abi: "BatchSettlement", address: A.BatchSettlement },
  PolarisSend: { contract: "PolarisSend", abi: "PolarisSend", address: A.PolarisSend },
  PolarisCheckout: { contract: "PolarisCheckout", abi: "PolarisCheckout", address: A.PolarisCheckout },
  CollectionsReceiver: { contract: "CollectionsReceiver", abi: "CollectionsReceiver", address: A.CollectionsReceiver },
  UnderwritingReceiver: { contract: "UnderwritingReceiver", abi: "UnderwritingReceiver", address: A.UnderwritingReceiver },
  MockKeystoneForwarder: { contract: "CreForwarder", abi: "MockKeystoneForwarder", address: SETTINGS.creForwarders[0]! },
  Stablecoin: { contract: "MerchantWallet", abi: "IAUSD", address: A.Stablecoin },
};

/** Local contract address -> configured address. */
const ADDRESS = new Map(Object.entries(fixture.contracts).map(([name, local]) => [local, RENAME[name]!.address]));
const mapAddress = (a: string) => ADDRESS.get(a) ?? a;

function paramTypes(abiName: string, event: string): Map<string, string> {
  const raw = JSON.parse(readFileSync(join(ROOT, "..", "contracts", "abi", `${abiName}.json`), "utf8"));
  const abi = (Array.isArray(raw) ? raw : raw.abi) as Array<{ type: string; name: string; inputs: Array<{ name: string; type: string }> }>;
  const e = abi.find((x) => x.type === "event" && x.name === event);
  if (!e) throw new Error(`${abiName}.${event} not in the ABI`);
  return new Map(e.inputs.map((i) => [i.name, i.type]));
}

/** Which (contract, event) pairs config.yaml indexes. */
const CONFIG = readFileSync(join(ROOT, "config.yaml"), "utf8");
function indexed(contract: string, event: string): boolean {
  const block = CONFIG.split("\n  - name: ").find((b) => b.startsWith(`${contract}\n`));
  return block !== undefined && block.includes(`"${event}(`);
}

/**
 * When each merchant account was registered as a MerchantWallet (mirrors
 * src/handlers/merchantWallet.ts: MerchantRegistered, and nothing else). The
 * simulated source, like HyperSync, only delivers stablecoin transfers that
 * touch one.
 */
const REGISTERS: Record<string, string> = {
  "MerchantRegistry.MerchantRegistered": "merchant",
};
const registeredAt = new Map<string, number>();
for (const e of fixture.events) {
  const key = REGISTERS[`${e.contract}.${e.event}`];
  if (!key) continue;
  const m = e.params[key] as string;
  if (!registeredAt.has(m)) registeredAt.set(m, e.blockNumber);
}
const isMerchantAt = (a: string, block: number) => (registeredAt.get(a) ?? Infinity) <= block;

function simulateItems(offset: number) {
  const items: Array<Record<string, unknown>> = [];
  for (const e of fixture.events) {
    const target = RENAME[e.contract];
    if (!target || !indexed(target.contract, e.event)) continue;
    if (target.contract === "MerchantWallet") {
      const { from, to } = e.params as { from: string; to: string };
      if (!isMerchantAt(from, e.blockNumber) && !isMerchantAt(to, e.blockNumber)) continue;
    }
    const types = paramTypes(target.abi, e.event);
    const params: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(e.params)) {
      const type = types.get(name)!;
      if (/^u?int\d+$/.test(type)) params[name] = BigInt(value as string);
      else if (type === "address") params[name] = mapAddress(value as string);
      else params[name] = value;
    }
    items.push({
      contract: target.contract,
      event: e.event,
      srcAddress: target.address,
      logIndex: e.logIndex,
      params,
      block: { number: e.blockNumber + offset, timestamp: e.timestamp },
      transaction: { hash: e.txHash, from: e.txFrom, to: e.txTo === null ? undefined : mapAddress(e.txTo) },
    });
  }
  return items;
}

describe("replaying a real local chain", () => {
  const sim = new Sim();

  beforeAll(async () => {
    const items = simulateItems(SETTINGS.startBlock);
    expect(items.length).toBeGreaterThan(100);
    await sim.indexer.process({ chains: { [CHAIN]: { simulate: items } } } as never);
  });

  chainChecks(() => sim.indexer, fixture);
});
