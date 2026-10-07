import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARC,
  ARC_TESTNET,
  EURC,
  SEPOLIA,
  USDC,
  ZERO_ADDRESS,
  assertDeployed,
  chainById,
  explorerTxUrl,
  isDeployed,
  resolveChain,
} from "../src/chains.js";
import { createPolaris } from "../src/client.js";
import { DEPLOYMENTS } from "../src/deployments.js";

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("chain presets", () => {
  it("describe Arc testnet and mainnet, with Circle's USDC as the dollar and the gas token", () => {
    expect(ARC_TESTNET).toMatchObject({
      key: "arc-testnet",
      chainId: 5042002,
      name: "Arc Testnet",
      rpcUrl: "https://rpc.testnet.arc.io",
      explorer: "https://explorer.testnet.arc.io",
      testnet: true,
      stablecoinSymbol: "USDC",
      stablecoinDecimals: 6,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      features: { payWithAuthorization: true },
    });
    expect(ARC).toMatchObject({
      key: "arc",
      chainId: 5042,
      name: "Arc",
      rpcUrl: "https://rpc.mainnet.arc.io",
      explorer: "https://explorer.arc.io",
      testnet: false,
      stablecoinSymbol: "USDC",
      nativeCurrency: { symbol: "USDC", decimals: 18 },
    });
    expect(ARC_TESTNET.stablecoin).toBe(DEPLOYMENTS.arcTestnet.stablecoin ?? USDC.arcTestnet);
    expect(ARC.stablecoin).toBe(DEPLOYMENTS.arc.stablecoin ?? USDC.arc);
  });

  it("export Circle's USDC and EURC addresses on Arc", () => {
    expect(USDC).toEqual({ arcTestnet: "0x3600000000000000000000000000000000000000", arc: "0x3600000000000000000000000000000000000000" });
    expect(EURC).toEqual({ arcTestnet: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", arc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1" });
  });

  it("take Polaris addresses from the generated deployments file, and nothing else", () => {
    for (const [preset, record] of [
      [ARC_TESTNET, DEPLOYMENTS.arcTestnet],
      [ARC, DEPLOYMENTS.arc],
    ] as const) {
      for (const [name, address] of Object.entries(record.contracts)) {
        expect(preset[name as keyof typeof record.contracts]).toBe(address);
      }
      expect(preset.deployment.source).toBe(record.source);
    }
  });

  it("are not deployed until packages/contracts has a deployment file, and say so", () => {
    if (DEPLOYMENTS.arcTestnet.source !== null) return; // deployed: covered by the test above
    expect(ARC_TESTNET.payments).toBe(ZERO_ADDRESS);
    expect(isDeployed(ARC_TESTNET, ["payments"])).toBe(false);
    expect(() => assertDeployed(ARC_TESTNET, ["payments"])).toThrow(
      /PolarisPayments is not deployed on Arc Testnet yet: its address in polarispay-sdk's deployments\.ts is the zero placeholder/,
    );
    expect(() => assertDeployed(ARC_TESTNET, ["collector"])).toThrow(/CollectionsReceiver is not deployed on Arc Testnet/);
    // The token is Circle's and always real.
    expect(isDeployed(ARC_TESTNET, ["stablecoin"])).toBe(true);
  });

  it("keep the 0.2 Sepolia deployment working", () => {
    expect(SEPOLIA.payments).toBe("0x3BD1609abDC915eA9e01A399a26e2B8A2a06243f");
    expect(SEPOLIA.features.payWithAuthorization).toBe(false);
    expect(isDeployed(SEPOLIA, ["payments", "loanEngine", "scoreManager", "collateralVault", "stablecoin"])).toBe(true);
  });

  it("upgrade a 0.2 contracts object, filling the rest from the known chain", () => {
    const legacy = {
      chainId: 11155111,
      name: "Sepolia",
      rpcUrl: "https://rpc.example",
      explorer: "https://sepolia.etherscan.io",
      stablecoin: SEPOLIA.stablecoin,
      loanEngine: "0x1111111111111111111111111111111111111111",
      scoreManager: SEPOLIA.scoreManager,
      collateralVault: SEPOLIA.collateralVault,
      payments: SEPOLIA.payments,
    };
    const chain = resolveChain(legacy);
    expect(chain.loanEngine).toBe(legacy.loanEngine);
    expect(chain.rpcUrl).toBe("https://rpc.example");
    expect(chain.key).toBe("sepolia");
    expect(chain.features.payWithAuthorization).toBe(false);

    const unknown = resolveChain({ ...legacy, chainId: 999 });
    expect(unknown.checkout).toBe(ZERO_ADDRESS);
    expect(() => assertDeployed(unknown, ["checkout"])).toThrow(/not deployed/);
  });

  it("look up by chain id and build explorer links", () => {
    expect(chainById(5042002)).toBe(ARC_TESTNET);
    expect(chainById(5042)).toBe(ARC);
    expect(chainById(1)).toBeUndefined();
    expect(explorerTxUrl(ARC, "0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
    expect(explorerTxUrl(ARC_TESTNET, "0xabc")).toBe("https://explorer.testnet.arc.io/tx/0xabc");
  });
});

describe("createPolaris chain selection", () => {
  it("picks Arc testnet for a test key and Arc for a live key", () => {
    expect(createPolaris({ publishableKey: "pk_test_51Hx8yQfT3sLk2Pz" }).chain).toBe(ARC_TESTNET);
    const live = createPolaris({ publishableKey: "pk_live_51Hx8yQfT3sLk2Pz" });
    expect(live.chain).toBe(ARC);
    expect(live.livemode).toBe(true);
  });

  it("keeps 0.2 callers (no key, no chain) on Sepolia", () => {
    const legacy = createPolaris();
    expect(legacy.chain).toBe(SEPOLIA);
    expect(legacy.contracts).toBe(SEPOLIA);
  });

  it("lets an explicit chain win", () => {
    const custom = { ...ARC_TESTNET, payments: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const };
    expect(createPolaris({ publishableKey: "pk_live_51Hx8yQfT3sLk2Pz", chain: custom }).chain).toBe(custom);
  });
});

describe("deployments.ts", () => {
  it("is up to date with packages/contracts/deployments", () => {
    expect(() => execFileSync(process.execPath, [join(sdkRoot, "scripts", "gen-deployments.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
