import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { baseLimit, decisionFor, explain, formatUnits, scoreFrom } from "../src/score.ts";
import { startGateway } from "../src/server.ts";

const facts = {
  walletAgeDays: 730,
  txCount: 300,
  stableBalance: 1_240_000_000n,
  defiTenureDays: 0,
  priorLiquidations: 0,
  relatedWallets: 0,
  exchangeFunded: true,
  observedAt: 1_790_424_000n,
};

describe("score explanations", () => {
  it("explains facts in the buyer's words, with points", () => {
    assert.deepEqual(explain(facts), [
      "You've used this account for 2 years · +48",
      "You've made 300 payments and transfers · +12",
      "You keep $1,240 on hand · +12",
      "First topped up from a major exchange · +10",
    ]);
  });

  it("scores with ScoreManager's formula and tiers", () => {
    const band = scoreFrom(facts);
    assert.equal(band.score, 520 + 48 + 12 + 12 + 10);
    assert.equal(band.limit, 500_000_000n);
    assert.equal(baseLimit(670), 1_000_000_000n);
    assert.equal(formatUnits(1_240_000_000n), "$1,240");
  });

  it("gives the whole decision for facts on chain", () => {
    const d = decisionFor(facts, { purchase: 400_000_000n });
    assert.equal(d.payIn4.allowed, true);
    assert.equal(d.limit, 500_000_000n);
  });
});

/** A JSON-RPC stand-in for Monad testnet on loopback (a test double): every balanceOf is $455. */
async function rpcStub(): Promise<{ url: string; server: Server; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call = JSON.parse(raw) as { id?: number; method: string };
      calls.push(call.method);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id ?? 1, result: `0x${(227_500_000).toString(16)}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("the gateway", () => {
  it("without provider keys: each is not_configured in /health and in the answer, never called, and nothing stands in", async () => {
    const rpc = await rpcStub();
    const { server, url } = await startGateway({ PORT: "0", MONAD_TESTNET_RPC_URL: rpc.url });
    try {
      const health = await (await fetch(`${url}/health`)).json();
      assert.deepEqual(health.modes, { nansen: "not_configured", zerion: "not_configured", etherscan: "not_configured", rpc: "live" });
      assert.deepEqual(
        health.notConfigured.map((n: { env: string }) => n.env),
        ["NANSEN_API_KEY", "ZERION_API_KEY", "ETHERSCAN_API_KEY"],
      );
      assert.doesNotMatch(JSON.stringify(health), /fixture/);

      const res = await fetch(`${url}/v1/underwrite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: "0xacc0000000000000000000000000000000000002" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.providers, health.modes);
      assert.deepEqual(body.notConfigured, [
        { provider: "zerion", env: "ZERION_API_KEY" },
        { provider: "etherscan", env: "ETHERSCAN_API_KEY" },
      ]);
      assert.deepEqual(body.absent.sort(), ["account.firstSeenAt", "account.sentCount"]);
      assert.equal(body.facts.stableBalance, "455000000", "the public RPC is live: two balances of $227.50");
      assert.equal(body.facts.txCount, 0, "absent, not counted");
      assert.equal(body.final, true);
      assert.equal(body.attest, false);
      assert.equal(body.report, null);
      assert.equal(body.unavailable, true);
      assert.equal(body.decision.headline, "Credit reviews aren't fully set up here yet.");
      assert.ok(rpc.calls.every((m) => m === "eth_call"));
      assert.doesNotMatch(JSON.stringify(body), /fixture/);
    } finally {
      await close(server);
      await close(rpc.server);
    }
  });

  it("refuses UNDERWRITING_MODE=fixture rather than start on synthesized data", async () => {
    await assert.rejects(startGateway({ PORT: "0", UNDERWRITING_MODE: "fixture" }), /UNDERWRITING_MODE=fixture is not supported/);
  });

  it("refuses to start on a host that is not loopback without a token, instead of serving an open API", async () => {
    for (const HOST of ["0.0.0.0", "::", "192.168.1.20", "8.8.8.8"]) {
      await assert.rejects(startGateway({ PORT: "0", HOST }), /refusing to serve .* without a token/, HOST);
      await assert.rejects(startGateway({ PORT: "0", HOST, UNDERWRITING_API_TOKEN: "   " }), /without a token/, `${HOST} with a blank token`);
    }
  });

  it("an empty HOST means loopback, not every interface", async () => {
    const { server, url } = await startGateway({ PORT: "0", HOST: "" });
    try {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const addr = server.address();
      assert.equal(typeof addr === "object" && addr ? addr.address : null, "127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("with a token, /v1/* answers only to it", async () => {
    const { server, url } = await startGateway({ PORT: "0", UNDERWRITING_API_TOKEN: "s3cret-token-for-tests" });
    try {
      const call = (auth?: string) =>
        fetch(`${url}/v1/explain`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
          body: JSON.stringify({ facts: { ...facts, stableBalance: "1240000000", observedAt: "1790424000" } }),
        });
      assert.equal((await call()).status, 401);
      assert.equal((await call("Bearer wrong")).status, 401);
      assert.equal((await call("Bearer s3cret-token-for-tests")).status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
