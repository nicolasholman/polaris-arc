import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

/**
 * The dollar the app signs for, and the chain it reads. With Polaris for
 * Business configured, an unset NEXT_PUBLIC_USDC_ADDRESS must mean "the one
 * the server's deployment reports" (network.ts refuses to sign when a
 * configured address differs): Circle's USDC on Arc, MockUSDC on a local
 * chain. The default chain is Arc testnet, with its own explorer.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const KEYS = ["NEXT_PUBLIC_POLARIS_API_URL", "NEXT_PUBLIC_USDC_ADDRESS", "NEXT_PUBLIC_CHAIN_ID", "NEXT_PUBLIC_EXPLORER_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let fresh = 0;

/** env.ts read with these variables, as a fresh module (it reads process.env once, at import). */
async function envWith(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  const mod = (await import(`../src/lib/env.ts?case=${++fresh}`)) as typeof import("../src/lib/env.ts");
  return mod.env;
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("env.contracts.usdc", () => {
  it("is unset with Polaris configured, so the deployment's own dollar is used", async () => {
    const env = await envWith({ NEXT_PUBLIC_POLARIS_API_URL: "http://localhost:3100" });
    assert.equal(env.contracts.usdc, ZERO);
    assert.equal(env.contracts.eurc, ZERO);
    assert.equal(env.contracts.sendEurc, ZERO);
  });

  it("is unset without Polaris too: no stand-in dollar for a build that can't sign", async () => {
    const env = await envWith({});
    assert.equal(env.contracts.usdc, ZERO);
    assert.equal(env.apiUrl, undefined);
  });

  it("is whatever the build pins, with or without Polaris", async () => {
    const pinned = "0x3600000000000000000000000000000000000000";
    assert.equal((await envWith({ NEXT_PUBLIC_POLARIS_API_URL: "http://localhost:3100", NEXT_PUBLIC_USDC_ADDRESS: pinned })).contracts.usdc, pinned);
    assert.equal((await envWith({ NEXT_PUBLIC_USDC_ADDRESS: pinned })).contracts.usdc, pinned);
  });
});

describe("env's chain", () => {
  it("defaults to Arc testnet and its explorer", async () => {
    const env = await envWith({});
    assert.equal(env.chainId, 5042002);
    assert.equal(env.localChain, false);
    assert.equal(env.explorerUrl, "https://explorer.testnet.arc.io");
  });

  it("knows Arc mainnet's explorer", async () => {
    const env = await envWith({ NEXT_PUBLIC_CHAIN_ID: "5042" });
    assert.equal(env.explorerUrl, "https://explorer.arc.io");
  });

  it("treats a Hardhat node as a local chain with no explorer unless one is set", async () => {
    const env = await envWith({ NEXT_PUBLIC_CHAIN_ID: "31337" });
    assert.equal(env.localChain, true);
    assert.equal(env.explorerUrl, "");
    assert.equal((await envWith({ NEXT_PUBLIC_CHAIN_ID: "31337", NEXT_PUBLIC_EXPLORER_URL: "http://127.0.0.1:4000/" })).explorerUrl, "http://127.0.0.1:4000");
  });
});
