import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

/**
 * The dollar the app signs for. With Polaris for Business configured, an
 * unset NEXT_PUBLIC_AUSD_ADDRESS must mean "the one the server's deployment
 * reports" (network.ts refuses to sign when a configured address differs).
 * Defaulting to Agora's AUSD there made the app refuse every signature
 * against the Monad testnet deployment, whose dollar is a labelled MockAUSD.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const KEYS = ["NEXT_PUBLIC_POLARIS_API_URL", "NEXT_PUBLIC_AUSD_ADDRESS"] as const;
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

describe("env.contracts.ausd", () => {
  it("is unset with Polaris configured, so the deployment's own dollar is used", async () => {
    const env = await envWith({ NEXT_PUBLIC_POLARIS_API_URL: "http://localhost:3100" });
    assert.equal(env.contracts.ausd, ZERO);
  });

  it("is unset without Polaris too: no stand-in dollar for a build that can't sign", async () => {
    const env = await envWith({});
    assert.equal(env.contracts.ausd, ZERO);
    assert.equal(env.apiUrl, undefined);
  });

  it("is whatever the build pins, with or without Polaris", async () => {
    const pinned = "0x3F9554F15f58Bb5900822224f37A05be81eF9723";
    assert.equal((await envWith({ NEXT_PUBLIC_POLARIS_API_URL: "http://localhost:3100", NEXT_PUBLIC_AUSD_ADDRESS: pinned })).contracts.ausd, pinned);
    assert.equal((await envWith({ NEXT_PUBLIC_AUSD_ADDRESS: pinned })).contracts.ausd, pinned);
  });
});
