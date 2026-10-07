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

const ACCOUNT = "0xacc0000000000000000000000000000000000002";
const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** A JSON-RPC stand-in for Arc testnet on loopback (a test double): every balanceOf is $227.50, the nonce 4. */
async function rpcStub(): Promise<{ url: string; server: Server; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call = JSON.parse(raw) as { id?: number; method: string };
      calls.push(call.method);
      const result = call.method === "eth_getTransactionCount" ? "0x4" : `0x${(227_500_000).toString(16)}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id ?? 1, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls };
}

/**
 * A Blockscout API stand-in for Arc's explorer on loopback (a test double):
 * the account's first transaction 120 days ago and 12 transfers it sent.
 */
async function explorerStub(): Promise<{ url: string; server: Server; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://stub").searchParams;
    const action = q.get("action") ?? "";
    calls.push(action);
    const rows =
      action === "txlist"
        ? [{ timeStamp: String(NOW_S - 120 * DAY), from: ACCOUNT, to: "0x5e00000000000000000000000000000000000001" }]
        : Array.from({ length: 12 }, (_, i) => ({ timeStamp: String(NOW_S - (100 - i) * DAY), from: ACCOUNT, to: "0x5e00000000000000000000000000000000000001" }));
    const sorted = q.get("sort") === "desc" ? [...rows].reverse() : rows;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "OK", status: "1", result: sorted.slice(0, Number(q.get("offset") ?? 100)) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, server, calls };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("the gateway", () => {
  it("without provider keys: the account on Arc is still read (keyless), the keyed providers are not_configured, never called", async () => {
    const rpc = await rpcStub();
    const explorer = await explorerStub();
    const { server, url } = await startGateway({ PORT: "0", UNDERWRITING_ACCOUNT_RPC_URL: rpc.url, UNDERWRITING_ACCOUNT_EXPLORER_API_URL: explorer.url });
    try {
      const health = await (await fetch(`${url}/health`)).json();
      assert.deepEqual(health.modes, { nansen: "not_configured", zerion: "not_configured", etherscan: "not_configured", rpc: "live", blockscout: "live" });
      assert.deepEqual(
        health.notConfigured.map((n: { env: string }) => n.env),
        ["NANSEN_API_KEY", "ZERION_API_KEY", "ETHERSCAN_API_KEY"],
      );
      assert.doesNotMatch(JSON.stringify(health), /fixture/);

      const res = await fetch(`${url}/v1/underwrite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: ACCOUNT }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.providers, health.modes);
      assert.deepEqual(body.notConfigured, [], "the account needs no keyed provider");
      assert.deepEqual(body.absent, []);
      assert.equal(body.facts.stableBalance, "455000000", "USDC and EURC, $227.50 each");
      assert.equal(body.facts.walletAgeDays, 120);
      assert.equal(body.facts.txCount, 12, "the 12 transfers it sent outnumber its nonce (4)");
      assert.equal(body.final, true);
      assert.equal(body.attest, true);
      assert.match(body.report, /^0x[0-9a-f]{832}$/);
      assert.deepEqual([...new Set(rpc.calls)].sort(), ["eth_call", "eth_getTransactionCount"]);
      assert.deepEqual([...new Set(explorer.calls)].sort(), ["tokentx", "txlist"]);
      assert.doesNotMatch(JSON.stringify(body), /fixture/);
    } finally {
      await close(server);
      await close(rpc.server);
      await close(explorer.server);
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
