import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIQUIDATION_POOLS } from "../src/core/constants.ts";
import { nansenRequests } from "../src/core/providers/nansen.ts";
import { fixtureTransport } from "../src/testing/fixtures.ts";
import { ProviderError } from "../src/node/http.ts";
import { NansenClient } from "../src/node/nansen.ts";
import { ZerionClient } from "../src/node/zerion.ts";
import { fixtureProviders, host, LINKED, ACCOUNT, NOW, scripted, status } from "./helpers.ts";

const DAY = 86_400;

describe("NansenClient against fixtures", () => {
  const { nansen } = fixtureProviders();

  it("is not configured without a key, and live with one: a keyless call sends nothing and names the variable", async () => {
    const t = scripted(fixtureTransport(), []);
    const keyless = new NansenClient({ transport: t });
    assert.equal(keyless.mode, "not_configured");
    assert.equal(new NansenClient({ apiKey: "   " }).mode, "not_configured", "a blank key is no key");
    assert.equal(new NansenClient({ apiKey: "nk_live" }).mode, "live");
    assert.equal(nansen.mode, "live");
    await assert.rejects(
      keyless.firstFunder(LINKED.strong),
      (e: ProviderError) => e.code === "not_configured" && !e.retryable && e.status === null && /NANSEN_API_KEY is not set/.test(e.message),
    );
    assert.equal(t.calls.length, 0, "nothing is sent, and nothing answers in Nansen's place");
  });

  it("first-funder", async () => {
    const f = await nansen.firstFunder(LINKED.strong);
    assert.equal(f?.name, "Coinbase: Hot Wallet 2");
    assert.equal(f?.chain, "ethereum");
    assert.equal(await nansen.firstFunder(LINKED.noFunder), null, "Nansen's empty answer is a known empty");
  });

  it("related-wallets, excluding the subject", async () => {
    const r = await nansen.relatedWallets("0xfeed000000000000000000000000000000000004", "ethereum", [LINKED.sybil]);
    assert.equal(r.count, 30);
    assert.deepEqual(r.relations, ["First Funder", "Funded"]);
  });

  it("current-balance, transactions, counterparties, pnl-summary and labels", async () => {
    assert.equal(await nansen.currentBalanceStables(LINKED.strong), 4_200_250_000);
    const oldestDex = await nansen.oldestTransaction(LINKED.strong, "all", NOW - 365 * DAY, NOW, "dex");
    assert.ok(oldestDex !== null && NOW - oldestDex > 339 * DAY && NOW - oldestDex < 341 * DAY);
    assert.equal(await nansen.oldestTransaction(LINKED.strong, "all", NOW - 30 * DAY, NOW, "dex"), null);
    const cps = await nansen.counterparties(LINKED.strong, "all", NOW - 180 * DAY, NOW, ["Exchange"]);
    assert.ok(cps[0]?.labels.includes("Exchange"));
    const pnl = await nansen.pnlSummary(LINKED.strong, "all", NOW - 365 * DAY, NOW);
    assert.equal(pnl.winRate, 0.62);
    const labels = await nansen.labels(LINKED.strong);
    assert.deepEqual(labels.map((l) => l.category), ["smart_money", "defi"]);
  });

  it("a request with no fixture fails; it is never answered as empty", async () => {
    await assert.rejects(nansen.firstFunder("0x0000000000000000000000000000000000000bad"), (e: ProviderError) => e.code === "not_found" && /no fixture recorded/.test(e.message) && !e.retryable);
  });

  it("maps Nansen's errors: out of credits, and the x402 challenge a refused key gets", async () => {
    const noCredits = new NansenClient({
      apiKey: "k",
      transport: scripted(fixtureTransport(), [{ match: host("nansen"), respond: () => status(403, { code: "insufficient_credits", message: "Not enough credits", status: 403, error: "Forbidden", request_id: "r", doc_url: "d" }) }]),
    });
    await assert.rejects(noCredits.firstFunder(LINKED.strong), (e: ProviderError) => e.code === "insufficient_credits" && !e.retryable);

    const refused = new NansenClient({ apiKey: "revoked", transport: scripted(fixtureTransport(), [{ match: host("nansen"), respond: () => status(402, {}) }]) });
    await assert.rejects(refused.firstFunder(LINKED.strong), (e: ProviderError) => e.code === "unauthorized");
  });

  it("a body Nansen's schema refuses fails in fixture mode as it would live: 422 unknown_field, request_rejected, no retry", async () => {
    const good = nansenRequests.firstFunder(LINKED.strong);
    // The alias the old recipe sent to first-funder: its schema knows only `address`.
    const wrong = { ...good, body: JSON.stringify({ wallet_address: LINKED.strong, chain: "all" }) };
    const t = scripted(fixtureTransport(), []);
    const res = await new NansenClient({ apiKey: "k", transport: t, retry: { attempts: 3 } }).execute(wrong);
    assert.equal(res.status, 422);
    const body = JSON.parse(res.body) as { code: string; param: string };
    assert.deepEqual([body.code, body.param], ["unknown_field", "wallet_address"]);
    assert.equal(t.calls.length, 1, "a refused body is not retried");

    const live = new NansenClient({ apiKey: "k", transport: scripted(fixtureTransport(), [{ match: host("nansen"), respond: () => status(422, body) }]) });
    await assert.rejects(live.firstFunder(LINKED.strong), (e: ProviderError) => e.code === "request_rejected" && !e.retryable && /param wallet_address/.test(e.message));

    // The builders refuse to build such a body at all, before any credit is spent.
    assert.throws(() => nansenRequests.relatedWallets(LINKED.strong, undefined as unknown as string), /missing_field: chain/);
  });

  it("sends the key in the apikey header", async () => {
    const t = scripted(fixtureTransport(), []);
    await new NansenClient({ apiKey: "nk_secret", transport: t }).firstFunder(LINKED.strong);
    assert.equal(t.calls[0]!.headers.apikey, "nk_secret");
  });
});

describe("ZerionClient against fixtures", () => {
  const { zerion } = fixtureProviders();

  it("reads the Polaris account's testnet history with X-Env", async () => {
    const page = await zerion.transactions(ACCOUNT.fresh, { testnet: true, chainIds: ["monad-test-v2"], pageSize: 100 });
    assert.equal(page.rows.length, 2);
    assert.equal(page.hasNext, false);
  });

  it("pages like the API: page[size] and links.next", async () => {
    const page = await zerion.transactions(ACCOUNT.regular, { testnet: true, pageSize: 10 });
    assert.equal(page.rows.length, 10);
    assert.equal(page.hasNext, true);
  });

  it("answers a probe for any 'now'", async () => {
    assert.equal(await zerion.hasActivityBefore(LINKED.strong, NOW - 1000 * DAY), true);
    assert.equal(await zerion.hasActivityBefore(LINKED.strong, NOW - 1300 * DAY), false);
    assert.equal(await zerion.hasActivityBefore(LINKED.strong, NOW - 700 * DAY, { operationTypes: ["trade", "deposit", "withdraw"] }), true);
    assert.equal(await zerion.hasActivityBefore(LINKED.strong, NOW - 900 * DAY, { operationTypes: ["trade", "deposit", "withdraw"] }), false);
  });

  it("sums dollars exactly and drops the spam 'USDC'", async () => {
    assert.deepEqual(await zerion.positionsStables(LINKED.strong), { micros: 4_200_250_000, notTrackable: false });
  });

  it("returns 'not trackable' as a known empty instead of throwing", async () => {
    assert.deepEqual(await zerion.positionsStables(LINKED.exchangeWallet), { micros: 0, notTrackable: true });
    assert.equal((await zerion.transactions(LINKED.exchangeWallet)).notTrackable, true);
  });

  it("authenticates with HTTP Basic, key as the username", async () => {
    const t = scripted(fixtureTransport(), []);
    await new ZerionClient({ apiKey: "zk_dev_123", transport: t }).positionsStables(LINKED.strong);
    assert.equal(t.calls[0]!.headers.Authorization, "Basic emtfZGV2XzEyMzo=");
  });

  it("without ZERION_API_KEY it is not configured and sends nothing", async () => {
    const t = scripted(fixtureTransport(), []);
    const keyless = new ZerionClient({ transport: t });
    assert.equal(keyless.mode, "not_configured");
    await assert.rejects(keyless.positionsStables(LINKED.strong), (e: ProviderError) => e.code === "not_configured" && /ZERION_API_KEY/.test(e.message));
    assert.equal(t.calls.length, 0);
  });
});

describe("EtherscanClient and RpcClient against fixtures", () => {
  const { etherscan, historyRpcs, accountRpc } = fixtureProviders();

  it("counts pool liquidations, ignoring the spoofed one", async () => {
    assert.equal(await etherscan.liquidationCount(1, LINKED.liquidated, LIQUIDATION_POOLS[1]!), 1);
    assert.equal(await etherscan.liquidationCount(42161, LINKED.liquidated, LIQUIDATION_POOLS[42161]!), 1);
    assert.equal(await etherscan.liquidationCount(1, LINKED.strong, LIQUIDATION_POOLS[1]!), 0);
  });

  it("puts the key in the query string after the cache key is taken", async () => {
    const { EtherscanClient } = await import("../src/node/etherscan.ts");
    const t = scripted(fixtureTransport(), []);
    await new EtherscanClient({ apiKey: "ek", transport: t }).liquidationCount(1, LINKED.strong, []);
    assert.match(t.calls[0]!.url, /&apikey=ek$/);
  });

  it("Etherscan without its key is not configured; a public RPC needs none and is always live", async () => {
    const { EtherscanClient } = await import("../src/node/etherscan.ts");
    const { RpcClient } = await import("../src/node/rpc.ts");
    const t = scripted(fixtureTransport(), []);
    const keyless = new EtherscanClient({ transport: t });
    assert.equal(keyless.mode, "not_configured");
    await assert.rejects(keyless.liquidationCount(1, LINKED.strong, []), (e: ProviderError) => e.code === "not_configured" && /ETHERSCAN_API_KEY/.test(e.message));
    assert.equal(t.calls.length, 0);
    assert.equal(new RpcClient("https://rpc.example", 1).mode, "live");
    assert.equal(accountRpc.mode, "live");
  });

  it("reads nonces and balances", async () => {
    const counts = await Promise.all(historyRpcs.map((c) => c.transactionCount(LINKED.strong)));
    assert.deepEqual(counts, [540, 290, 70]);
    assert.equal(await accountRpc.balanceOf("0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", ACCOUNT.fresh), 37_600_000n);
  });
});
