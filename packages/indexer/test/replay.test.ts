/**
 * Replay a real chain through the real handlers.
 *
 * test/fixtures/local-chain.json is recorded by scripts/record-fixture.mjs: a
 * local Hardhat chain running scripts/fixture-chain.cjs (the contract layer
 * deployed as on Arc testnet, then every flow: the keeper's underwriting and
 * collections reports, a failed collection, a liquidation with seized
 * collateral, the credit guard's override, USDC and EURC links, payouts, a
 * quoted order, cancellations, a batch). Its logs are replayed here at the
 * configured addresses, and the indexed state must equal what the contracts
 * themselves report.
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
  PolarisSendEURC: { contract: "PolarisSendEURC", abi: "PolarisSend", address: A.PolarisSendEURC },
  PolarisCheckout: { contract: "PolarisCheckout", abi: "PolarisCheckout", address: A.PolarisCheckout },
  CollectionsReceiver: { contract: "CollectionsReceiver", abi: "CollectionsReceiver", address: A.CollectionsReceiver },
  UnderwritingReceiver: { contract: "UnderwritingReceiver", abi: "UnderwritingReceiver", address: A.UnderwritingReceiver },
  CreditGuard: { contract: "CreditGuard", abi: "CreditGuard", address: A.CreditGuard },
  USDC: { contract: "MerchantWallet", abi: "IUSDC", address: A.USDC },
};

/** Local contract address -> configured address. */
const ADDRESS = new Map(Object.entries(fixture.contracts).map(([name, local]) => [local, RENAME[name]!.address]));
const mapAddress = (a: string) => ADDRESS.get(a) ?? a;

type AbiParam = { name: string; type: string; components?: AbiParam[] };

function paramTypes(abiName: string, event: string): Map<string, AbiParam> {
  const raw = JSON.parse(readFileSync(join(ROOT, "..", "contracts", "abi", `${abiName}.json`), "utf8"));
  const abi = (Array.isArray(raw) ? raw : raw.abi) as Array<{ type: string; name: string; inputs: AbiParam[] }>;
  const e = abi.find((x) => x.type === "event" && x.name === event);
  if (!e) throw new Error(`${abiName}.${event} not in the ABI`);
  return new Map(e.inputs.map((i) => [i.name, i]));
}

/** A recorded value as Envio hands it to a handler: uints as bigint, addresses mapped, structs as tuples. */
function paramValue(param: AbiParam, value: unknown): unknown {
  if (param.type === "tuple") return (param.components ?? []).map((c, i) => paramValue(c, (value as unknown[])[i]));
  if (/^u?int\d+$/.test(param.type)) return BigInt(value as string);
  if (param.type === "address") return mapAddress(value as string);
  return value;
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
 * simulated source, like HyperSync, only delivers USDC transfers that
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
    for (const [name, value] of Object.entries(e.params)) params[name] = paramValue(types.get(name)!, value);
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

  chainChecks(() => sim.indexer, fixture, A);
});
