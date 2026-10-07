/**
 * The app server's client, against the real router mounted as a Fetch
 * handler: no socket, the same bytes the gateway sends.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createUnderwritingClient, poweredBy, UnderwritingApiError } from "../src/client/index.ts";
import { encodeUnderwritingReport } from "../src/core/abi.ts";
import { linkMessage } from "../src/core/link.ts";
import type { Address, Facts } from "../src/core/types.ts";
import { fixtureTransport } from "../src/testing/fixtures.ts";
import { createFetchHandler, type HandlerOptions } from "../src/node/handler.ts";
import type { HttpTransport } from "../src/node/http.ts";
import { NansenClient } from "../src/node/nansen.ts";
import { Underwriter } from "../src/node/service.ts";
import { ACCOUNT, fixtureProviders, LINKED, NOW } from "./helpers.ts";

// A throwaway key generated for this test; it controls nothing.
const OWNER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

/** Fixture providers that read the throwaway owner's address as the strong persona's history. */
function underwriter(): Underwriter {
  const from = OWNER.address.toLowerCase();
  const alias = (s: string) => s.replaceAll(from, LINKED.strong).replaceAll(from.slice(2), LINKED.strong.slice(2));
  const inner = fixtureTransport();
  const t: HttpTransport = (req, signal) => inner({ ...req, url: alias(req.url), body: req.body && alias(req.body) }, signal);
  const p = fixtureProviders(t);
  p.nansen = new NansenClient({ apiKey: "test-nansen-key", transport: t, clock: p.clock, cacheTtlMs: 0 });
  return new Underwriter({ providers: p, now: () => NOW });
}

function mounted(opts: HandlerOptions = {}) {
  const handle = createFetchHandler(underwriter(), opts);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handle(new Request(url, init));
  };
  return { fetch, calls };
}

const onChain: Facts = {
  walletAgeDays: 730,
  txCount: 300,
  stableBalance: 1_240_000_000n,
  defiTenureDays: 0,
  priorLiquidations: 0,
  relatedWallets: 0,
  exchangeFunded: true,
  observedAt: BigInt(NOW),
};

describe("the underwriting client", () => {
  it("a proven history: a Nansen-powered decision the app can show, credited to Nansen", async () => {
    const { fetch } = mounted({ token: "t0k3n-for-tests" });
    const uw = createUnderwritingClient({ baseUrl: "http://gateway.test", token: "t0k3n-for-tests", fetch });
    const issuedAt = NOW - 60;
    const nonce = "n0nce-12345";
    const message = await uw.linkMessage({ account: ACCOUNT.fresh, wallet: OWNER.address, issuedAt, nonce });
    assert.equal(message, linkMessage({ account: ACCOUNT.fresh, wallet: OWNER.address, issuedAt, nonce }), "the text the wallet signs");
    const signature = await OWNER.signMessage({ message });

    const a = await uw.underwrite({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address, proof: { issuedAt, nonce, signature } }, purchase: 600_000_000n });
    assert.equal(a.final, true);
    assert.equal(a.attest, true);
    assert.match(a.report ?? "", /^0x[0-9a-f]{832}$/);
    assert.equal(a.decision.limit, "1000000000");
    assert.equal(a.decision.payIn4.allowed, true);
    assert.equal(a.decision.payIn4.quote?.principal, "600000000");
    assert.deepEqual(a.providers, { nansen: "live", zerion: "live", etherscan: "live", rpc: "live" });
    assert.deepEqual(a.notConfigured, []);

    const nansen = poweredBy(a.decision.reasons).find((c) => c.provider === "nansen");
    assert.equal(nansen?.name, "Nansen");
    assert.ok(nansen?.reasons.includes("age") && nansen.reasons.includes("exchange"), JSON.stringify(nansen));
    assert.equal(a.decision.reasons.find((r) => r.id === "exchange")?.text, "First topped up from Coinbase, a major exchange · +10");
  });

  it("a thin file: final, nothing to attest, and what is left", async () => {
    const uw = createUnderwritingClient({ baseUrl: "http://gateway.test", fetch: mounted().fetch });
    const a = await uw.underwrite({ account: ACCOUNT.fresh });
    assert.equal(a.final, true);
    assert.equal(a.attest, false);
    assert.equal(a.report, null);
    assert.equal(a.decision.limit, "0");
    assert.deepEqual(a.decision.thinFile, [
      { fact: "walletAgeDays", have: 3, need: 90 },
      { fact: "txCount", have: 2, need: 10 },
    ]);
  });

  it("explains what the DON attested, from the facts or from the report itself, with base-unit purchases", async () => {
    const uw = createUnderwritingClient({ baseUrl: "http://gateway.test", fetch: mounted().fetch });
    const byFacts = await uw.explainFacts(onChain, { purchase: 400_000_000n });
    assert.equal(byFacts.breakdown.score, 520 + 48 + 12 + 12 + 10);
    assert.equal(byFacts.decision.limit, "500000000");
    assert.equal(byFacts.decision.payIn4.quote?.principal, "400000000");
    assert.equal(byFacts.facts.stableBalance, "1240000000");

    const report = encodeUnderwritingReport([{ user: ACCOUNT.fresh, linkedWallet: LINKED.strong, facts: onChain }]);
    const byReport = await uw.explainReport(report, { purchase: 400_000_000n });
    assert.equal(byReport.kind, 2);
    assert.equal(byReport.items.length, 1);
    assert.equal(byReport.items[0]?.user, ACCOUNT.fresh.toLowerCase());
    assert.equal(byReport.items[0]?.linkedWallet, LINKED.strong.toLowerCase());
    assert.deepEqual(byReport.items[0]?.breakdown, byFacts.breakdown, "the same facts score the same, however they arrive");
    assert.equal(byReport.items[0]?.decision.limit, "500000000");
    assert.ok(poweredBy(byReport.items[0]!.decision.reasons).some((c) => c.provider === "nansen"), "an exchange funding can only have come from Nansen");
  });

  it("sends the bearer token only when it has one, and surfaces the API's errors with their codes", async () => {
    const m = mounted({ token: "right" });
    await assert.rejects(
      createUnderwritingClient({ baseUrl: "http://gateway.test", token: "wrong", fetch: m.fetch }).underwrite({ account: ACCOUNT.regular }),
      (e: UnderwritingApiError) => e instanceof UnderwritingApiError && e.status === 401 && e.code === "unauthorized",
    );
    const health = await createUnderwritingClient({ baseUrl: "http://gateway.test", fetch: m.fetch }).health();
    assert.equal(health.ok, true, "health needs no token");
    assert.equal(health.version.model, 3);
    assert.equal(new Headers(m.calls[0]!.init.headers).get("authorization"), "Bearer wrong");
    assert.equal(new Headers(m.calls[1]!.init.headers).get("authorization"), null);

    const limited = mounted({ rateLimitPerMinute: 1 });
    const uw = createUnderwritingClient({ baseUrl: "http://gateway.test", fetch: limited.fetch });
    await uw.underwrite({ account: ACCOUNT.regular });
    await assert.rejects(uw.underwrite({ account: ACCOUNT.regular }), (e: UnderwritingApiError) => e.status === 429 && e.code === "rate_limited");
  });

  it("refuses bad input before spending a request, and keeps a path prefix", async () => {
    const m = mounted();
    const uw = createUnderwritingClient({ baseUrl: "http://gateway.test/underwriting/", fetch: m.fetch });
    assert.throws(() => uw.underwrite({ account: "0x1234" as Address }), /account must be/);
    assert.throws(() => uw.underwrite({ account: ACCOUNT.regular, purchase: -1n }), /purchase must be/);
    assert.equal(m.calls.length, 0);
    await uw.health().catch(() => undefined);
    assert.equal(m.calls[0]?.url, "http://gateway.test/underwriting/health");
    assert.throws(() => createUnderwritingClient({ baseUrl: "not a url" }), /not a URL/);
    assert.throws(() => createUnderwritingClient({ baseUrl: "file:///etc/passwd" }), /http or https/);
  });
});
