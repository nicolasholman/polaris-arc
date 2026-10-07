import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { encodeUnderwritingReport } from "../src/core/abi.ts";
import { createFetchHandler, createRouter, type RouteRequest } from "../src/node/handler.ts";
import { assertSafeBind, isLoopbackAddress, isLoopbackHost, startUnderwritingServer } from "../src/node/server.ts";
import { Underwriter } from "../src/node/service.ts";
import { ACCOUNT, fixtureProviders, LINKED, NOW } from "./helpers.ts";

const uw = () => new Underwriter({ providers: fixtureProviders(), now: () => NOW });

const req = (o: Partial<RouteRequest> & { json?: unknown }): RouteRequest => ({
  method: o.method ?? "POST",
  url: o.url ?? "/v1/underwrite",
  headers: { "content-type": "application/json", ...(o.headers ?? {}) },
  body: o.body ?? (o.json === undefined ? "" : JSON.stringify(o.json)),
  client: o.client ?? "test",
});

describe("the underwriting API", () => {
  it("GET /health reports each provider live or not_configured, never anything else", async () => {
    const res = await createRouter(uw())(req({ method: "GET", url: "/health" }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.modes, { nansen: "live", zerion: "live", etherscan: "live", rpc: "live" });
    assert.deepEqual(body.notConfigured, []);
    assert.deepEqual(body.version, { facts: 1, model: 3 });

    const partial = new Underwriter({ providers: fixtureProviders(undefined, { notConfigured: ["nansen", "zerion"] }), now: () => NOW });
    const h = JSON.parse((await createRouter(partial)(req({ method: "GET", url: "/health" }))).body);
    assert.deepEqual(h.modes, { nansen: "not_configured", zerion: "not_configured", etherscan: "live", rpc: "live" });
    assert.deepEqual(h.notConfigured, [
      { provider: "nansen", env: "NANSEN_API_KEY" },
      { provider: "zerion", env: "ZERION_API_KEY" },
    ]);
  });

  it("POST /v1/underwrite: the decision, with amounts as base-unit strings", async () => {
    const res = await createRouter(uw())(req({ json: { account: ACCOUNT.regular, purchase: "150.00" } }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.final, true);
    assert.equal(body.attest, true);
    assert.deepEqual(body.providers, { nansen: "live", zerion: "live", etherscan: "live", rpc: "live" });
    assert.deepEqual(body.notConfigured, []);
    assert.equal(body.decision.limit, "200000000");
    assert.equal(body.decision.thinFile, null);
    assert.equal(body.decision.payIn4.allowed, true);
    assert.equal(body.decision.payIn4.quote.total, "151150684");
    assert.equal(body.facts.stableBalance, "455000000");
    assert.match(body.report, /^0x[0-9a-f]{832}$/);
    assert.equal(body.evidence.account.stableBalance.source, "rpc.balance");
    assert.equal(body.derivation, undefined, "the bulky derivation is not sent");
    assert.ok(body.attribution.walletAgeDays);
  });

  it("a thin file is final with no report: the app shows what is left and does not trigger the DON", async () => {
    const res = await createRouter(uw())(req({ json: { account: ACCOUNT.fresh, purchase: "150.00" } }));
    const body = JSON.parse(res.body);
    assert.equal(body.final, true);
    assert.equal(body.attest, false);
    assert.equal(body.report, null);
    assert.equal(body.retryAfterSeconds, null, "nothing to wait for: a retry gives the same answer");
    assert.equal(body.decision.limit, "0");
    assert.equal(body.decision.payIn4.allowed, false);
    assert.deepEqual(body.decision.thinFile, [
      { fact: "walletAgeDays", have: 3, need: 90 },
      { fact: "txCount", have: 2, need: 10 },
    ]);
  });

  it("a linked wallet without a proof comes back as a preview", async () => {
    const res = await createRouter(uw())(req({ json: { account: ACCOUNT.fresh, linked: { wallet: LINKED.strong } } }));
    const body = JSON.parse(res.body);
    assert.equal(body.final, false);
    assert.deepEqual(body.missing, ["linked.ownership"]);
    assert.equal(body.report, null);
    assert.equal(body.decision.limit, "1000000000", "the preview shows what linking would give");
  });

  it("validates input", async () => {
    const route = createRouter(uw());
    const cases: Array<[RouteRequest, number, string]> = [
      [req({ json: { account: "0x123" } }), 400, "invalid_field"],
      [req({ body: "{not json" }), 400, "invalid_json"],
      [req({ json: { account: ACCOUNT.fresh }, headers: { "content-type": "text/plain" } }), 415, "unsupported_media_type"],
      [req({ json: { account: ACCOUNT.fresh, purchase: "two hundred" } }), 400, "invalid_field"],
      [req({ json: { account: ACCOUNT.fresh, linked: { wallet: LINKED.strong, proof: { nonce: 1 } } } }), 400, "invalid_field"],
      [req({ method: "GET" }), 405, "method_not_allowed"],
      [req({ url: "/v1/nope" }), 404, "not_found"],
      [req({ body: "x".repeat(20_000) }), 413, "too_large"],
    ];
    for (const [r, code, err] of cases) {
      const res = await route(r);
      assert.equal(res.status, code, `${r.method} ${r.url} ${r.body.slice(0, 40)}`);
      assert.equal(JSON.parse(res.body).error.code, err);
    }
  });

  it("requires the bearer token when one is set", async () => {
    const route = createRouter(uw(), { token: "t0k3n" });
    assert.equal((await route(req({ json: { account: ACCOUNT.fresh } }))).status, 401);
    assert.equal((await route(req({ json: { account: ACCOUNT.fresh }, headers: { authorization: "Bearer wrong" } }))).status, 401);
    assert.equal((await route(req({ json: { account: ACCOUNT.fresh }, headers: { authorization: "Bearer t0k3n" } }))).status, 200);
    assert.equal((await route(req({ method: "GET", url: "/health" }))).status, 200, "health stays open");
  });

  it("answers CORS only for allowlisted origins, never *", async () => {
    const route = createRouter(uw(), { corsOrigins: ["https://app.polarispay.app"] });
    const ok = await route(req({ method: "OPTIONS", headers: { origin: "https://app.polarispay.app" } }));
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], "https://app.polarispay.app");
    const no = await route(req({ method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    assert.equal(no.headers["access-control-allow-origin"], undefined);
  });

  it("rate-limits underwriting per client, since each one spends Nansen credits", async () => {
    let t = 0;
    const route = createRouter(uw(), { rateLimitPerMinute: 2, now: () => t });
    const r = req({ json: { account: ACCOUNT.fresh } });
    assert.equal((await route(r)).status, 200);
    assert.equal((await route(r)).status, 200);
    assert.equal((await route(r)).status, 429);
    assert.equal((await route({ ...r, client: "other" })).status, 200);
    t = 60_001;
    assert.equal((await route(r)).status, 200);
  });

  it("POST /v1/explain: facts already on chain, or the report UnderwritingReceiver decoded", async () => {
    const facts = { walletAgeDays: 730, txCount: 300, stableBalance: "1240000000", defiTenureDays: 0, priorLiquidations: 0, relatedWallets: 0, exchangeFunded: false, observedAt: String(NOW) };
    const route = createRouter(uw());
    const a = JSON.parse((await route(req({ url: "/v1/explain", json: { facts } }))).body);
    assert.equal(a.breakdown.score, 520 + 48 + 12 + 12);
    assert.ok(a.decision.reasons.some((r: { text: string }) => r.text === "You've used this account for 2 years · +48"));

    const onChain = { ...facts, stableBalance: 1_240_000_000n, observedAt: BigInt(NOW) };
    const report = encodeUnderwritingReport([{ user: ACCOUNT.fresh, linkedWallet: LINKED.strong, facts: onChain }]);
    const b = JSON.parse((await route(req({ url: "/v1/explain", json: { report } }))).body);
    assert.equal(b.kind, 2);
    assert.equal(b.user, ACCOUNT.fresh.toLowerCase());
    assert.equal(b.linkedWallet, LINKED.strong.toLowerCase());
    assert.equal(b.breakdown.score, a.breakdown.score);
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].decision.limit, b.decision.limit);

    // A batch explains every item; an account scored alone has no linked wallet.
    const batch = encodeUnderwritingReport([
      { user: ACCOUNT.fresh, linkedWallet: null, facts: onChain },
      { user: ACCOUNT.regular, linkedWallet: LINKED.modest, facts: { ...onChain, priorLiquidations: 2 } },
    ]);
    const m = JSON.parse((await route(req({ url: "/v1/explain", json: { report: batch } }))).body);
    assert.equal(m.items.length, 2);
    assert.equal(m.items[0].linkedWallet, null);
    assert.equal(m.items[1].breakdown.declined, true);
    assert.equal(m.decision, undefined, "no single decision for a batch");

    // The research sketch's single-item layout is not a report the receiver decodes.
    const legacy = `0x${(2).toString(16).padStart(64, "0")}${ACCOUNT.fresh.slice(2).padStart(64, "0")}${"00".repeat(256)}`;
    const refused = await route(req({ url: "/v1/explain", json: { report: legacy } }));
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.body).error.message, /^report: /);
    assert.equal((await route(req({ url: "/v1/explain", json: { report: 42 } }))).status, 400);

    const bad = await route(req({ url: "/v1/explain", json: { facts: { ...facts, relatedWallets: 70_000 } } }));
    assert.equal(bad.status, 400);
  });

  it("GET /v1/link-message: the exact text to sign", async () => {
    const res = await createRouter(uw())(req({ method: "GET", url: `/v1/link-message?account=${ACCOUNT.fresh}&wallet=${LINKED.strong}&issuedAt=${NOW}&nonce=abcdef123` }));
    const { message } = JSON.parse(res.body);
    assert.match(message, /^Polaris: count this wallet's history toward my credit line\./);
    assert.match(message, /Issued: 2026-09-26T12:00:00Z/);
  });

  it("the Fetch adapter serves a Next.js route handler", async () => {
    const handle = createFetchHandler(uw());
    const res = await handle(new Request("http://app.local/v1/underwrite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: ACCOUNT.regular }) }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { decision: { limit: string } }).decision.limit, "200000000");
  });
});

describe("the node:http server", () => {
  let server: Server;
  let url: string;
  before(async () => {
    ({ server, url } = await startUnderwritingServer({ port: 0, underwriter: uw() }));
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves the same API over a socket", async () => {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const res = await fetch(`${url}/v1/underwrite`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: ACCOUNT.regular }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { facts: { walletAgeDays: number } };
    assert.equal(body.facts.walletAgeDays, 90);
    const big = await fetch(`${url}/v1/underwrite`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(40_000) });
    assert.equal(big.status, 413);
  });
});

describe("binding without a token", () => {
  it("knows loopback from everything else", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:127.0.0.9"]) {
      assert.equal(isLoopbackAddress(a), true, a);
    }
    for (const a of ["0.0.0.0", "::", "", "10.0.0.1", "192.168.1.20", "::ffff:10.0.0.1", "fe80::1", "128.0.0.1", "localhost"]) {
      assert.equal(isLoopbackAddress(a), false, a);
    }
  });

  it("resolves names: localhost is loopback; wildcards, empty and unresolvable hosts are not", async () => {
    assert.equal(await isLoopbackHost("localhost"), true);
    assert.equal(await isLoopbackHost("127.0.0.1"), true);
    assert.equal(await isLoopbackHost("0.0.0.0"), false);
    assert.equal(await isLoopbackHost("::"), false);
    assert.equal(await isLoopbackHost(""), false);
    assert.equal(await isLoopbackHost("no-such-host.invalid"), false);
  });

  it("refuses to start on a host that is not loopback, and starts there with a token", async () => {
    for (const host of ["0.0.0.0", "::", "", "192.168.1.20"]) {
      await assert.rejects(startUnderwritingServer({ port: 0, host, underwriter: uw() }), /refusing to serve .* without a token/, host);
      await assert.rejects(startUnderwritingServer({ port: 0, host, token: "  ", underwriter: uw() }), /without a token/, `${host} with a blank token`);
      await assert.doesNotReject(assertSafeBind(host, "a-real-token"));
    }
    const { server, url } = await startUnderwritingServer({ port: 0, host: "localhost", underwriter: uw() });
    try {
      assert.equal((await fetch(`${url}/health`)).status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
