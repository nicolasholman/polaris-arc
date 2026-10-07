import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error: a plain .mjs script with no type declarations.
import { addressOf, load, render } from "../scripts/gen-deployments.mjs";

const TESTNET = { key: "monadTestnet", file: "monad-testnet.json", chainId: 10143 };
const dirs: string[] = [];

function dirWith(record: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "polaris-sdk-gen-"));
  dirs.push(dir);
  writeFileSync(join(dir, TESTNET.file), JSON.stringify(record));
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("gen-deployments", () => {
  // The shape packages/contracts/lib/deploy.js writes for Monad: one object per contract.
  const monadRecord = {
    chainId: 10143,
    deployedAt: "2026-09-28T12:00:00.000Z",
    contracts: {
      Stablecoin: { address: "0x1111111111111111111111111111111111111111", kind: "MockAUSD", blockNumber: 1, txHash: "0xab" },
      PolarisPayments: { address: "0x2222222222222222222222222222222222222222", blockNumber: 2, txHash: "0xcd" },
      PolarisCheckout: { address: "0x3333333333333333333333333333333333333333", blockNumber: 3, txHash: "0xef" },
      GuardianReceiver: { address: "0x4444444444444444444444444444444444444444", blockNumber: 4, txHash: "0x01" },
    },
  };

  it("reads the Monad deploy script's per-contract objects", () => {
    const r = load(TESTNET, dirWith(monadRecord));
    expect(r.contracts.payments).toBe("0x2222222222222222222222222222222222222222");
    expect(r.contracts.checkout).toBe("0x3333333333333333333333333333333333333333");
    // The deployment's own dollar (a labelled MockAUSD on testnet) is the preset's stablecoin.
    expect(r.stablecoin).toBe("0x1111111111111111111111111111111111111111");
    // Contracts the record lacks stay the zero placeholder the SDK refuses to use.
    expect(r.contracts.batchSettlement).toBe("0x0000000000000000000000000000000000000000");
    expect(render([r])).toContain('checkout: "0x3333333333333333333333333333333333333333"');
  });

  it("still reads the older records' bare address strings", () => {
    const r = load(TESTNET, dirWith({ chainId: 10143, contracts: { PolarisPayments: "0x2222222222222222222222222222222222222222", AUSD: "0x5555555555555555555555555555555555555555" } }));
    expect(r.contracts.payments).toBe("0x2222222222222222222222222222222222222222");
    expect(r.stablecoin).toBe("0x5555555555555555555555555555555555555555");
  });

  it("refuses an entry that is not an address, and a record on the wrong chain", () => {
    expect(() => load(TESTNET, dirWith({ chainId: 10143, contracts: { PolarisPayments: { address: "nope" } } }))).toThrow(/PolarisPayments is not an address/);
    expect(() => load(TESTNET, dirWith({ ...monadRecord, chainId: 143 }))).toThrow(/chainId is 143, expected 10143/);
    expect(addressOf(undefined)).toBeUndefined();
  });
});
