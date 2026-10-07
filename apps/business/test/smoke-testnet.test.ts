import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collections, openStore } from "@polaris/db";
import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain ESM script with no type declarations.
import { keysFrom, markdownFrom, preflight, privyRelayerFrom, relayerModeFrom, relaysOfKind } from "../scripts/smoke-testnet.mjs";

/**
 * smoke:testnet's refusals: it writes to Monad testnet only, only against
 * the mock dollar it can mint, and only with the relayer (Privy's server
 * wallet, or the dev key) the deployment gave its roles. Every refusal
 * happens before anything is sent.
 */

const KEY_A = `0x${"11".repeat(32)}`;
const KEY_B = `0x${"22".repeat(32)}`;
const RELAYER = "0x5e6934725eBCdfcA2d95D991045Fa813B51E2c69";
const record = (over: Record<string, unknown> = {}) => ({
  chainId: 10143,
  contracts: { Stablecoin: { address: "0x3F9554F15f58Bb5900822224f37A05be81eF9723", kind: "MockAUSD" } },
  roles: { relayer: RELAYER },
  ...over,
});
const ready = { keys: { deployer: KEY_A, relayer: KEY_B }, relayerAddress: RELAYER, relayerBalance: 10n ** 18n, deployerBalance: 10n ** 18n, minRelayer: 10n ** 17n, minDeployer: 10n ** 17n };

describe("smoke:testnet preflight", () => {
  it("is ready with the testnet record, both keys, the recorded relayer and MON", () => {
    expect(preflight({ ...ready, record: record() })).toEqual([]);
  });

  it("refuses without a record, on another chain, or with real AUSD it cannot mint", () => {
    expect(preflight({ ...ready, record: null })[0]).toMatch(/deploy:monad/);
    expect(preflight({ ...ready, record: record({ chainId: 143 }) }).join(" ")).toMatch(/only ever writes to Monad testnet/);
    expect(preflight({ ...ready, record: record({ contracts: { Stablecoin: { address: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", kind: "AUSD" } } }) }).join(" ")).toMatch(/not the mock/);
  });

  it("refuses a relayer key the deployment did not give roles to, missing keys, and empty wallets", () => {
    const other = "0x000000000000000000000000000000000000dEaD";
    expect(preflight({ ...ready, record: record(), relayerAddress: other }).join(" ")).toMatch(/gave operator roles to/);
    expect(preflight({ ...ready, record: record(), keys: { deployer: null, relayer: null } })).toHaveLength(2);
    expect(preflight({ ...ready, record: record(), relayerBalance: 0n, deployerBalance: 0n })).toHaveLength(2);
  });

  it("reads keys with or without 0x and rejects anything else", () => {
    expect(keysFrom({ DEPLOYER_PRIVATE_KEY: "11".repeat(32), TESTNET_RELAYER_PRIVATE_KEY: KEY_B })).toEqual({ deployer: KEY_A, relayer: KEY_B });
    expect(keysFrom({})).toEqual({ deployer: null, relayer: null });
    expect(() => keysFrom({ DEPLOYER_PRIVATE_KEY: "0x1234" })).toThrow(/32-byte hex key/);
  });
});

describe("smoke:testnet with the Privy relayer", () => {
  const PRIVY = "0x1234567890abcdef1234567890abcdef12345678";
  const privyEnv = { NEXT_PUBLIC_PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret", PRIVY_RELAYER_WALLET_ID: "w1", PRIVY_RELAYER_AUTH_KEY: "k", PRIVY_RELAYER_ADDRESS: PRIVY };

  it("runs with the Privy relayer when it is configured, and --relayer chooses", () => {
    expect(relayerModeFrom([], privyEnv)).toBe("privy");
    expect(relayerModeFrom([], {})).toBe("local");
    expect(relayerModeFrom(["--relayer", "local"], privyEnv)).toBe("local");
    expect(() => relayerModeFrom(["--relayer", "raw"], {})).toThrow(/privy or local/);
  });

  it("needs the app's credentials and the relayer wallet from privy:setup-relayer", () => {
    expect(privyRelayerFrom(privyEnv)).toMatchObject({ appId: "app", problems: [] });
    expect(privyRelayerFrom(privyEnv).address?.toLowerCase()).toBe(PRIVY);
    const { problems } = privyRelayerFrom({});
    expect(problems.join(" ")).toMatch(/PRIVY_APP_SECRET/);
    expect(problems.join(" ")).toMatch(/setup-relayer/);
  });

  it("needs no dev relayer key, but refuses a Privy relayer the deployment gave no roles to", () => {
    const privyReady = { ...ready, keys: { deployer: KEY_A, relayer: null }, mode: "privy" };
    expect(preflight({ ...privyReady, record: record({ roles: { relayer: PRIVY } }), relayerAddress: PRIVY })).toEqual([]);
    expect(preflight({ ...privyReady, record: record(), relayerAddress: PRIVY }).join(" ")).toMatch(/privy relayer is .* gave operator roles to/);
    expect(preflight({ ...privyReady, record: record({ roles: { relayer: PRIVY } }), relayerAddress: PRIVY, privyProblems: ["no wallet"] })).toEqual(["no wallet"]);
  });

  it("writes a table a reader can follow: every step, and the users' MON before and after", () => {
    const md = markdownFrom({
      at: "2026-09-28T12:00:00.000Z",
      relayer: { mode: "privy", address: PRIVY, walletId: "w1", policyId: "p1", transactions: 2, monSpent: "0.05" },
      activator: null,
      steps: [{ what: "Pay now", signedBy: "buyer", by: "Privy relayer", contract: "PolarisCheckout", txHash: `0x${"ab".repeat(32)}`, explorer: "https://testnet.monadscan.com/tx/0xab", block: 1 }],
      users: [{ address: KEY_A.slice(0, 42), role: "buyer", monBefore: "0", monAfter: "0", nonceBefore: 0, nonceAfter: 0 }],
      webhooks: [{ type: "payment.succeeded", id: "evt_1" }],
    });
    expect(md).toMatch(/the Privy server wallet `0x1234/);
    expect(md).toMatch(/| 1 | Pay now | buyer | Privy relayer | PolarisCheckout |/);
    expect(md).toMatch(/| buyer | 0 | 0 | 0 | 0 |/);
    expect(md).toMatch(/payment.succeeded/);
  });
});

describe("smoke:testnet reading the server's own relays", () => {
  it("finds one kind (not an indexed field), oldest first, only those with a transaction that didn't fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-smoke-test-"));
    const dbUrl = `sqlite:${join(dir, "polaris.db")}`;
    try {
      const store = openStore(dbUrl);
      const relays = collections(store).relays;
      const row = (id: string, kind: string, createdAt: string, over: Record<string, unknown> = {}) =>
        relays.insert({
          id,
          kind,
          state: "confirmed",
          signer: null,
          to: "0x40A351282C9843C49f5Dd788d730a3d9Fe7627B4",
          txHash: `0x${id.charCodeAt(0).toString(16).padStart(64, "0")}`,
          blockNumber: 1,
          sessionId: null,
          merchantId: null,
          result: null,
          error: null,
          createdAt,
          updatedAt: createdAt,
          ...over,
        } as never);
      await row("b", "activateMerchant", "2026-09-28T10:00:02.000Z");
      await row("a", "activateMerchant", "2026-09-28T10:00:01.000Z");
      await row("c", "quoteOrder", "2026-09-28T10:00:00.000Z");
      await row("d", "activateMerchant", "2026-09-28T10:00:03.000Z", { state: "failed" });
      await row("e", "activateMerchant", "2026-09-28T10:00:04.000Z", { txHash: null, state: "pending" });
      store.close();

      const found = await relaysOfKind(dbUrl, "activateMerchant");
      expect(found.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
      expect((await relaysOfKind(dbUrl, "quoteOrder")).map((r: { id: string }) => r.id)).toEqual(["c"]);
      expect(await relaysOfKind(dbUrl, "lockCollateral")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
