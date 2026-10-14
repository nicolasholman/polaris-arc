import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as me } from "@/app/api/me/route";
import { getConfig, resetConfig } from "@/server/env";

import { DEPLOYMENT, json, params, request, setupServer } from "./helpers/env";

/**
 * `pnpm demo:local`'s signed-in dashboard: the demo merchant for one random
 * token, on a local chain in development with Privy off, and nowhere else.
 */

const TOKEN = "local-demo-token-0123456789abcdefghijklmnop";
const WALLET = "0x4444444444444444444444444444444444444444";

const withToken = (token: string) => request("GET", "/api/me", { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  setupServer({ POLARIS_LOCAL_SESSION_TOKEN: TOKEN, POLARIS_LOCAL_SESSION_WALLET: WALLET });
});

const saved: Record<string, string | undefined> = {};
function setEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
  resetConfig();
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  resetConfig();
});

describe("the local demo session", () => {
  it("signs the dashboard in as the demo merchant with the run's token", async () => {
    const res = await json(await me(withToken(TOKEN), params({})));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data).toLowerCase()).toContain(WALLET);
  });

  it("refuses any other token, and a request with none, as unauthenticated", async () => {
    // Sign-in is configured (the local session), so a missing or wrong token
    // is a 401, never "sign-in isn't configured".
    expect((await me(withToken(`${TOKEN.slice(0, -1)}x`), params({}))).status).toBe(401);
    expect((await me(request("GET", "/api/me"), params({}))).status).toBe(401);
  });

  it("can't be configured with Privy on, in production, or with a guessable token", () => {
    setEnv({ POLARIS_DISABLE_PRIVY: "0" });
    expect(() => getConfig()).toThrow(/demo:local/);
    setEnv({ POLARIS_DISABLE_PRIVY: "1", NODE_ENV: "production" });
    expect(() => getConfig()).toThrow(/demo:local/);
    setEnv({ NODE_ENV: "test", POLARIS_LOCAL_SESSION_TOKEN: "short" });
    expect(() => getConfig()).toThrow(/at least 32/);
  });
});


describe("loopback mainnet recording session", () => {
  it("requires development, explicit opt-in, loopback and no public signing key", () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-recording-"));
    try {
      const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
      deployment.chainId = 5042;
      const file = join(dir, "mainnet.json");
      writeFileSync(file, JSON.stringify(deployment));
      setEnv({ NODE_ENV: "development", POLARIS_DEPLOYMENT_FILE: file,
        RELAYER_MODE: "privy", PRIVY_RELAYER_WALLET_ID: "test-wallet",
        PRIVY_RELAYER_ADDRESS: WALLET, PRIVY_RELAYER_AUTH_KEY: "test-auth-key",
        POLARIS_DISABLE_PRIVY: "0", POLARIS_LOCAL_MAINNET_RECORDING: "1",
        POLARIS_PUBLIC_URL: "http://127.0.0.1:9601" });
      expect(getConfig().localSession?.wallet).toBe(WALLET);
      for (const changes of [
        { POLARIS_LOCAL_MAINNET_RECORDING: "0" },
        { POLARIS_PUBLIC_URL: "https://example.com" },
        { NEXT_PUBLIC_POLARIS_LOCAL_SESSION_KEY: "present" },
        { NODE_ENV: "production" },
      ] as Record<string, string>[]) {
        const before = Object.fromEntries(Object.keys(changes).map(k => [k, process.env[k] ?? ""]));
        setEnv(changes);
        expect(() => getConfig()).toThrow(/demo:local/);
        setEnv(before);
      }
    } finally { rmSync(dir, { recursive: true }); }
  });
});
