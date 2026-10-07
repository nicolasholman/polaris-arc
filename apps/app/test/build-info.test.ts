import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildInfo, type BuildInputs } from "../src/lib/build-info.ts";
import { env as appEnv } from "../src/lib/env.ts";

/**
 * GET /api/health's body: what scripts/deploy-check.mjs reads to prove a
 * hosted build has no dev signer, no local demo switches, and talks to the
 * right API, chain and relying party.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const CHECKOUT = "0x3874ef1bcE222755525a96f8284631780b9bC70B";

function inputs(overrides: Partial<Omit<BuildInputs, "env">> & { env?: Partial<typeof appEnv> } = {}): BuildInputs {
  const { env, ...rest } = overrides;
  return {
    env: {
      ...appEnv,
      devSigner: false,
      chainId: 5042002,
      apiUrl: "https://business.example",
      rpId: "example",
      privyAppId: "cm-test",
      contracts: { usdc: ZERO, eurc: ZERO, payments: ZERO, checkout: ZERO, send: ZERO, sendEurc: ZERO, split: ZERO, loanEngine: ZERO },
      ...env,
    } as typeof appEnv,
    nodeEnv: "production",
    devSignerPersist: undefined,
    localDemo: undefined,
    localFaucetUrl: undefined,
    ...rest,
  };
}

describe("buildInfo", () => {
  it("describes a hosted build: production, no dev signer, the API, chain, relying party and Privy app", () => {
    assert.deepEqual(buildInfo(inputs()), {
      service: "polaris-app",
      production: true,
      devSigner: false,
      devSignerPersist: false,
      localDemo: false,
      localFaucet: false,
      chainId: 5042002,
      apiUrl: "https://business.example",
      rpId: "example",
      privyAppId: "cm-test",
      pinnedContracts: {},
    });
  });

  it("names every switch a public deployment must not have", () => {
    const info = buildInfo(
      inputs({ env: { devSigner: true, chainId: 31337, localChain: true }, nodeEnv: "development", devSignerPersist: "1", localDemo: "1", localFaucetUrl: "http://127.0.0.1:3650" }),
    );
    assert.equal(info.production, false);
    assert.equal(info.devSigner, true);
    assert.equal(info.devSignerPersist, true);
    assert.equal(info.localDemo, true);
    assert.equal(info.localFaucet, true);
  });

  it("offers the local faucet on the local chain only", () => {
    assert.equal(buildInfo(inputs({ localFaucetUrl: "http://127.0.0.1:3650" })).localFaucet, false);
  });

  it("lists only the contracts the build pins, and reports an unset API, relying party and Privy app as null", () => {
    const info = buildInfo(
      inputs({ env: { apiUrl: undefined, rpId: undefined, privyAppId: undefined, contracts: { usdc: ZERO, eurc: ZERO, payments: ZERO, checkout: CHECKOUT, send: ZERO, sendEurc: ZERO, split: ZERO, loanEngine: ZERO } } }),
    );
    assert.deepEqual(info.pinnedContracts, { checkout: CHECKOUT });
    assert.equal(info.apiUrl, null);
    assert.equal(info.rpId, null);
    assert.equal(info.privyAppId, null);
  });
});
