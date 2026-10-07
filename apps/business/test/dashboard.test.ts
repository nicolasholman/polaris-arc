import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { GET as listKeys, POST as createKey } from "@/app/api/keys/route";
import { GET as overview } from "@/app/api/overview/route";
import { GET as payouts } from "@/app/api/payouts/route";
import { GET as network } from "@/app/api/public/network/route";
import { GET as listWebhooks, POST as createWebhook } from "@/app/api/webhooks/route";
import { setMerchantVerifierForTests } from "@/server/auth";

import { json, params, request, setupServer, signIn } from "./helpers/env";

beforeEach(() => {
  setupServer();
});

describe("dashboard routes", () => {
  it("answer 503 without Privy configured, never an unauthenticated fallback", async () => {
    setMerchantVerifierForTests(null);
    const res = await json(await listKeys(request("GET", "/api/keys"), params({})));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("auth_not_configured");
  });

  it("never return a secret key or its hash after creation", async () => {
    signIn({ userId: "did:privy:m", walletAddress: "0x2222222222222222222222222222222222222222" });
    const created = await json(await createKey(request("POST", "/api/keys", { body: { name: "Server" } }), params({})));
    expect(created.body.data.secret).toMatch(/^sk_test_/);
    const listed = await json(await listKeys(request("GET", "/api/keys"), params({})));
    const text = JSON.stringify(listed.body);
    expect(text).not.toContain(created.body.data.secret);
    expect(text).not.toContain("secretHash");
    expect(listed.body.data[0].secretHint).toMatch(/^sk_test_…/);
  });

  it("show a webhook secret once, and refuse endpoints a server shouldn't call", async () => {
    signIn({ userId: "did:privy:m", walletAddress: "0x2222222222222222222222222222222222222222" });
    const created = await json(await createWebhook(request("POST", "/api/webhooks", { body: { url: "https://hooks.example.com/polaris", events: ["payment.succeeded"] } }), params({})));
    expect(created.status).toBe(201);
    expect(created.body.data.secret).toMatch(/^whsec_/);
    const listed = await json(await listWebhooks(request("GET", "/api/webhooks"), params({})));
    expect(JSON.stringify(listed.body)).not.toContain(created.body.data.secret);
    for (const url of ["ftp://hooks.example.com", "https://user:pw@hooks.example.com/x", "https://169.254.169.254/latest"]) {
      const res = await createWebhook(request("POST", "/api/webhooks", { body: { url, events: ["payment.succeeded"] } }), params({}));
      expect(res.status, url).toBe(400);
    }
  });

  it("show an empty book when no chain is configured, never an invented one", async () => {
    setupServer({ POLARIS_DEPLOYMENT_FILE: "does-not-exist.json", RELAYER_MODE: "off" });
    signIn({ userId: "did:privy:nochain", walletAddress: "0x2222222222222222222222222222222222222222" });
    const res = await json(await overview(request("GET", "/api/overview"), params({})));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ balanceCents: 0, today: { count: 0, grossCents: 0, payments: [] }, collector: { state: "stopped", lastPassAt: null } });
    expect(res.body.data).not.toHaveProperty("sample");
  });

  it("show the real book, from chain events only, when a chain is configured", async () => {
    signIn({ userId: "did:privy:real", walletAddress: "0x2222222222222222222222222222222222222222" });
    const res = await json(await overview(request("GET", "/api/overview"), params({})));
    expect(res.body.data).toMatchObject({ balanceCents: 100_000, today: { count: 0 } });
  });

  it("report the balance as unknown, never $0.00, when the chain read fails (Overview and Payouts)", async () => {
    const env = setupServer();
    env.chain.reads.balanceOf = () => {
      throw new Error("upstream RPC error");
    };
    signIn({ userId: "did:privy:rpc-down", walletAddress: "0x2222222222222222222222222222222222222222" });
    const o = await json(await overview(request("GET", "/api/overview"), params({})));
    expect(o.status).toBe(200);
    expect(o.body.data.balanceCents).toBeNull();
    const p = await json(await payouts(request("GET", "/api/payouts"), params({})));
    expect(p.status).toBe(200);
    expect(p.body.data.balanceCents).toBeNull();

    // The same merchant once the chain answers again: the real balance.
    env.chain.reads.balanceOf = () => 1_990_000n;
    const again = await json(await payouts(request("GET", "/api/payouts"), params({})));
    expect(again.body.data.balanceCents).toBe(199);
  });
});

describe("public routes", () => {
  it("/api/health reports the wiring without a secret", async () => {
    const res = await json(await health(request("GET", "/api/health"), params({})));
    expect(res.body.data).toMatchObject({ ok: true, relayer: { mode: "local" }, chain: { id: 31337 } });
    expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE|secret|pepper/i);
  });

  it("/api/public/network serves the contracts and their EIP-712 domains", async () => {
    const res = await json(await network(request("GET", "/api/public/network"), params({})));
    expect(res.body.data.domains.checkout).toMatchObject({ name: "PolarisCheckout", version: "1", chainId: 31337 });
    expect(res.body.data.domains.stablecoin).toMatchObject({ name: "Agora Dollar", version: "1" });
  });
});

describe("scripts/check-api-auth.mjs", () => {
  it("passes: every route is exported through the wrapper its path requires", () => {
    const script = fileURLToPath(new URL("../scripts/check-api-auth.mjs", import.meta.url));
    const out = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/every handler authenticated/);
  });
});
