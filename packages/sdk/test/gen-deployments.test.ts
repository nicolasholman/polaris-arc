import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error: a plain .mjs script with no type declarations.
import { addressOf, load, render } from "../scripts/gen-deployments.mjs";

const TESTNET = { key: "arcTestnet", file: "arc-testnet.json", chainId: 5042002 };
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
  // The shape packages/contracts/lib/deploy.js writes for Arc: one object per contract.
  const arcRecord = {
    network: "testnet",
    chainId: 5042002,
    deployedAt: "2026-10-07T12:00:00.000Z",
    contracts: {
      USDC: { address: "0x3600000000000000000000000000000000000000", kind: "Circle USDC on Arc", abi: "abi/IUSDC.json" },
      PolarisPayments: { address: "0x2222222222222222222222222222222222222222", blockNumber: 2, txHash: "0xcd" },
      PolarisCheckout: { address: "0x3333333333333333333333333333333333333333", blockNumber: 3, txHash: "0xef" },
      CollectionsReceiver: { address: "0x4444444444444444444444444444444444444444", blockNumber: 4, txHash: "0x01" },
      CreditGuard: { address: "0x6666666666666666666666666666666666666666", blockNumber: 5, txHash: "0x02" },
    },
  };

  it("reads the Arc deploy script's per-contract objects", () => {
    const r = load(TESTNET, dirWith(arcRecord));
    expect(r.contracts.payments).toBe("0x2222222222222222222222222222222222222222");
    expect(r.contracts.checkout).toBe("0x3333333333333333333333333333333333333333");
    // The keeper's CollectionsReceiver keeps the SDK field name `collector`.
    expect(r.contracts.collector).toBe("0x4444444444444444444444444444444444444444");
    // contracts.USDC is the preset's stablecoin.
    expect(r.stablecoin).toBe("0x3600000000000000000000000000000000000000");
    // Contracts the record lacks stay the zero placeholder the SDK refuses to use.
    expect(r.contracts.batchSettlement).toBe("0x0000000000000000000000000000000000000000");
    expect(render([r])).toContain('checkout: "0x3333333333333333333333333333333333333333"');
  });

  it("still reads the older records' bare address strings", () => {
    const r = load(TESTNET, dirWith({ chainId: 5042002, contracts: { PolarisPayments: "0x2222222222222222222222222222222222222222", MockUSDC: "0x5555555555555555555555555555555555555555" } }));
    expect(r.contracts.payments).toBe("0x2222222222222222222222222222222222222222");
    expect(r.stablecoin).toBe("0x5555555555555555555555555555555555555555");
  });

  it("refuses an entry that is not an address, and a record on the wrong chain", () => {
    expect(() => load(TESTNET, dirWith({ chainId: 5042002, contracts: { PolarisPayments: { address: "nope" } } }))).toThrow(/PolarisPayments is not an address/);
    // arc-local.json (chainId 31337) is not a preset, and a local record dropped in as testnet is refused.
    expect(() => load(TESTNET, dirWith({ ...arcRecord, chainId: 31337 }))).toThrow(/chainId is 31337, expected 5042002/);
    expect(addressOf(undefined)).toBeUndefined();
  });
});
