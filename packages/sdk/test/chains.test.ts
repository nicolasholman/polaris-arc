import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUSD,
  MONAD,
  MONAD_TESTNET,
  SEPOLIA,
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
  it("describe Monad testnet and mainnet, with Agora's AUSD", () => {
    expect(MONAD_TESTNET).toMatchObject({
      key: "monad-testnet",
      chainId: 10143,
      rpcUrl: "https://testnet-rpc.monad.xyz",
      explorer: "https://testnet.monadvision.com",
      stablecoinSymbol: "AUSD",
      stablecoinDecimals: 6,
      nativeCurrency: { symbol: "MON", decimals: 18 },
      features: { payWithAuthorization: true },
    });
    expect(MONAD).toMatchObject({ key: "monad", chainId: 143, rpcUrl: "https://rpc.monad.xyz", testnet: false });
    expect(MONAD_TESTNET.stablecoin).toBe(DEPLOYMENTS.monadTestnet.stablecoin ?? AUSD.monadTestnet);
    expect(MONAD.stablecoin).toBe(DEPLOYMENTS.monad.stablecoin ?? AUSD.monad);
  });

  it("take Polaris addresses from the generated deployments file, and nothing else", () => {
    for (const [preset, record] of [
      [MONAD_TESTNET, DEPLOYMENTS.monadTestnet],
      [MONAD, DEPLOYMENTS.monad],
    ] as const) {
      for (const [name, address] of Object.entries(record.contracts)) {
        expect(preset[name as keyof typeof record.contracts]).toBe(address);
      }
      expect(preset.deployment.source).toBe(record.source);
    }
  });

  it("are not deployed until packages/contracts has a deployment file, and say so", () => {
    if (DEPLOYMENTS.monadTestnet.source !== null) return; // deployed: covered by the test above
    expect(MONAD_TESTNET.payments).toBe(ZERO_ADDRESS);
    expect(isDeployed(MONAD_TESTNET, ["payments"])).toBe(false);
    expect(() => assertDeployed(MONAD_TESTNET, ["payments"])).toThrow(
      /PolarisPayments is not deployed on Monad Testnet yet: its address in polarispay-sdk's deployments\.ts is the zero placeholder/,
    );
    // The token is Agora's and always real.
    expect(isDeployed(MONAD_TESTNET, ["stablecoin"])).toBe(true);
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
    expect(chainById(10143)).toBe(MONAD_TESTNET);
    expect(chainById(1)).toBeUndefined();
    expect(explorerTxUrl(MONAD, "0xabc")).toBe("https://monadvision.com/tx/0xabc");
  });
});

describe("createPolaris chain selection", () => {
  it("picks Monad testnet for a test key and Monad for a live key", () => {
    expect(createPolaris({ publishableKey: "pk_test_51Hx8yQfT3sLk2Pz" }).chain).toBe(MONAD_TESTNET);
    const live = createPolaris({ publishableKey: "pk_live_51Hx8yQfT3sLk2Pz" });
    expect(live.chain).toBe(MONAD);
    expect(live.livemode).toBe(true);
  });

  it("keeps 0.2 callers (no key, no chain) on Sepolia", () => {
    const legacy = createPolaris();
    expect(legacy.chain).toBe(SEPOLIA);
    expect(legacy.contracts).toBe(SEPOLIA);
  });

  it("lets an explicit chain win", () => {
    const custom = { ...MONAD_TESTNET, payments: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const };
    expect(createPolaris({ publishableKey: "pk_live_51Hx8yQfT3sLk2Pz", chain: custom }).chain).toBe(custom);
  });
});

describe("deployments.ts", () => {
  it("is up to date with packages/contracts/deployments", () => {
    expect(() => execFileSync(process.execPath, [join(sdkRoot, "scripts", "gen-deployments.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
