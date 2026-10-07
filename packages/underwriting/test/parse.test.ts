import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exchangeIn, riskIn } from "../src/core/labels.ts";
import { base64Ascii, largestHit, ParseError, parseTimestamp, queryString } from "../src/core/providers/common.ts";
import { etherscanRequests, parseLiquidationCount, parseTokenTransfers } from "../src/core/providers/etherscan.ts";
import {
  classifyNansenFailure,
  NANSEN_REQUEST_SCHEMA,
  nansenBodyProblem,
  nansenRequests,
  parseCurrentBalanceStables,
  parseFirstFunder,
  parseNansenError,
  parseRelatedWallets,
} from "../src/core/providers/nansen.ts";
import { parseRpcQuantity } from "../src/core/providers/rpc.ts";
import { isNotTrackable, parsePositionsStables, parseTransactions, zerionAuthorization, zerionRequests } from "../src/core/providers/zerion.ts";

describe("timestamps (Nansen's format is UNVERIFIED, so read them all)", () => {
  it("reads ISO with and without an offset as UTC, never the machine's zone", () => {
    assert.equal(parseTimestamp("2024-01-02T03:04:05Z"), 1704164645);
    assert.equal(parseTimestamp("2024-01-02T03:04:05"), 1704164645);
    assert.equal(parseTimestamp("2024-01-02 03:04:05"), 1704164645);
    assert.equal(parseTimestamp("2024-01-02T03:04:05.789Z"), 1704164645);
    assert.equal(parseTimestamp("2024-01-02T05:04:05+02:00"), 1704164645);
    assert.equal(parseTimestamp("2024-01-01T22:04:05-0500"), 1704164645);
    assert.equal(parseTimestamp("2024-01-02"), 1704153600);
  });

  it("reads unix seconds and milliseconds, as numbers or strings", () => {
    assert.equal(parseTimestamp(1704164645), 1704164645);
    assert.equal(parseTimestamp(1704164645123), 1704164645);
    assert.equal(parseTimestamp("1704164645"), 1704164645);
  });

  it("returns null for anything else", () => {
    for (const v of ["", "yesterday", null, undefined, -1, 0, Number.NaN, {}]) assert.equal(parseTimestamp(v), null);
  });
});

describe("Nansen parsers", () => {
  it("first-funder: a row, or null for Nansen's documented empty answer", () => {
    const f = parseFirstFunder({
      pagination: { page: 1, per_page: 10, is_last_page: true },
      data: [{ wallet_address: "0xb0b0000000000000000000000000000000000001", first_funder_address: "0xC0BA5E0000000000000000000000000000000002", first_funder_name: "Coinbase: Hot Wallet 2", transaction_hash: "0x1", block_timestamp: "2023-06-04T09:36:07Z", chain: "ethereum" }],
    });
    assert.deepEqual(f, { address: "0xc0ba5e0000000000000000000000000000000002", name: "Coinbase: Hot Wallet 2", chain: "ethereum", fundedAt: 1685871367 });
    assert.equal(parseFirstFunder({ pagination: { page: 1, per_page: 10, is_last_page: true }, data: [] }), null);
  });

  it("first-funder: a shape it does not recognise is an error, not an empty", () => {
    assert.throws(() => parseFirstFunder({ data: [{ funder: "0x1" }] }), ParseError);
    assert.throws(() => parseFirstFunder({ items: [] }), ParseError);
    assert.throws(() => parseFirstFunder("nope"), ParseError);
  });

  it("related-wallets: counts distinct wallets, minus the subjects, and 100 when there is another page", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, "0")}`, relation: "Funded", transaction_hash: "0x", block_timestamp: "2025-01-01", order: i, chain: "base" }));
    const self = "0x0000000000000000000000000000000000000001";
    assert.equal(parseRelatedWallets({ pagination: { is_last_page: true }, data: [...rows(7), ...rows(2)] }, [self]).count, 6);
    const partial = parseRelatedWallets({ pagination: { is_last_page: false }, data: rows(100) }, [self]);
    assert.equal(partial.count, 100);
    assert.equal(partial.complete, false);
  });

  it("current-balance: dollars only, and only near $1, so a spam token called USDC cannot pass", () => {
    const micros = parseCurrentBalanceStables({
      data: [
        { token_symbol: "USDC", token_amount: 100.25, price_usd: 1, value_usd: 100.25 },
        { token_symbol: "dai", token_amount: 50, price_usd: 0.999, value_usd: 49.95 },
        { token_symbol: "USDC", token_amount: 1_000_000, price_usd: 0.0001, value_usd: 100 },
        { token_symbol: "ETH", token_amount: 2, price_usd: 3000, value_usd: 6000 },
      ],
    });
    assert.equal(micros, 150_250_000);
  });

  it("errors: Nansen's envelope, with retry_after", () => {
    assert.deepEqual(parseNansenError({ error: "x", message: "slow down", code: "rate_limit_exceeded", status: 429, request_id: "r", doc_url: "d", retry_after: 3 }), {
      code: "rate_limit_exceeded",
      message: "slow down",
      param: null,
      retryAfterSeconds: 3,
    });
    assert.equal(parseNansenError({ data: [] }), null);
    assert.equal(parseNansenError({ code: "unknown_field", message: "m", param: "wallet_address" })?.param, "wallet_address");
    assert.equal(parseNansenError({ code: "unknown_field", message: "m", param: "" })?.param, null);
  });

  it("classifies a refusal: our body is wrong (request_rejected, with Nansen's param), not Nansen being down", () => {
    const refused = classifyNansenFailure(422, { code: "unknown_field", message: "Extra inputs are not permitted", param: "wallet_address" });
    assert.equal(refused.code, "request_rejected");
    assert.equal(refused.detail, "HTTP 422 unknown_field (param wallet_address): Extra inputs are not permitted");
    assert.equal(classifyNansenFailure(400, {}).code, "request_rejected");
    assert.equal(classifyNansenFailure(418, { code: "invalid_date_range", message: "" }).code, "request_rejected");
    assert.equal(classifyNansenFailure(403, {}).code, "insufficient_credits");
    assert.equal(classifyNansenFailure(429, { code: "insufficient_credits" }).code, "insufficient_credits");
    assert.deepEqual(classifyNansenFailure(402, "not json"), { code: "unauthorized", detail: "HTTP 402 payment required (no API key)" });
    assert.equal(classifyNansenFailure(401, {}).code, "unauthorized");
    assert.equal(classifyNansenFailure(404, {}).code, "not_found");
    assert.deepEqual(classifyNansenFailure(503, null), { code: "http_error", detail: "HTTP 503" });
  });

  it("every body the builders make is one Nansen's closed request schemas accept, with the wallet in the field each endpoint names", () => {
    const w = "0xB0B0000000000000000000000000000000000001";
    const built = {
      "first-funder": nansenRequests.firstFunder(w),
      "related-wallets": nansenRequests.relatedWallets(w, "ethereum"),
      counterparties: nansenRequests.counterparties(w, "ethereum", 1704164645, 1704164699),
      transactions: nansenRequests.transactions(w, "all", 1704164645, 1704164699),
      "pnl-summary": nansenRequests.pnlSummary(w, "ethereum", 1704164645, 1704164699),
      "current-balance": nansenRequests.currentBalance(w),
      labels: nansenRequests.labels(w),
    } as const;
    assert.deepEqual(Object.keys(built).sort(), Object.keys(NANSEN_REQUEST_SCHEMA).sort(), "a builder per schema");
    for (const [endpoint, spec] of Object.entries(built)) {
      const body = JSON.parse(spec.body ?? "{}") as Record<string, unknown>;
      assert.equal(nansenBodyProblem(endpoint, body), null, endpoint);
      const subject = NANSEN_REQUEST_SCHEMA[endpoint as keyof typeof NANSEN_REQUEST_SCHEMA].subject;
      assert.equal(body[subject], w.toLowerCase(), `${endpoint} puts the wallet in ${subject}`);
      assert.ok(spec.url.endsWith(`/${endpoint}`), spec.url);
    }
    assert.equal(NANSEN_REQUEST_SCHEMA["related-wallets"].subject, "wallet_address");
    assert.equal(NANSEN_REQUEST_SCHEMA["pnl-summary"].subject, "wallet_address");
    assert.equal(NANSEN_REQUEST_SCHEMA["first-funder"].subject, "address");
  });

  it("says why Nansen would refuse a body, in its own vocabulary", () => {
    const w = "0xb0b0000000000000000000000000000000000001";
    assert.deepEqual(nansenBodyProblem("first-funder", { wallet_address: w, chain: "all" }), { code: "unknown_field", param: "wallet_address" });
    assert.deepEqual(nansenBodyProblem("related-wallets", { wallet_address: w }), { code: "missing_field", param: "chain" });
    assert.deepEqual(nansenBodyProblem("related-wallets", { address: w, chain: "ethereum" }), { code: "deprecated_field", param: "address" });
    assert.deepEqual(nansenBodyProblem("current-balance", { chain: "all" }), { code: "missing_field", param: "address" });
    assert.equal(nansenBodyProblem("current-balance", { entity_name: "Coinbase", chain: "all" }), null, "an entity instead of a wallet is allowed");
    assert.deepEqual(nansenBodyProblem("transactions", "nope"), { code: "missing_field", param: "address" });
    assert.deepEqual(nansenBodyProblem("smart-money", {}), { code: "unknown_endpoint", param: null });
  });

  it("requests are byte-stable: lowercase addresses, fixed key order, dates to the minute", () => {
    const a = nansenRequests.firstFunder("0xB0B0000000000000000000000000000000000001");
    assert.equal(a.body, '{"address":"0xb0b0000000000000000000000000000000000001","chain":"all"}');
    assert.equal(a.url, "https://api.nansen.ai/api/v1/profiler/address/first-funder");
    const t = nansenRequests.transactions("0xb0b0000000000000000000000000000000000001", "all", 1704164645, 1704164699, { sourceType: "dex" });
    assert.match(t.body ?? "", /"date":\{"from":"2024-01-02T03:04:00Z","to":"2024-01-02T03:04:00Z"\}/);
    assert.equal(JSON.parse(t.body ?? "{}").pagination.per_page, 1);
  });
});

describe("Zerion parsers", () => {
  it("positions: sums exactly from quantity.int, DAI's 18 decimals included, and skips trash and unverified", () => {
    const pos = (symbol: string, int: string, decimals: number, o: Record<string, unknown> = {}) => ({
      type: "positions",
      attributes: {
        position_type: "wallet",
        quantity: { int, decimals, float: 0, numeric: "0" },
        price: 1,
        fungible_info: { symbol, flags: { verified: true }, implementations: [] },
        flags: { is_trash: false, displayable: true },
        ...o,
      },
    });
    const micros = parsePositionsStables({
      data: [
        pos("USDC", "3100250000", 6),
        pos("DAI", "250000000000000000001", 18),
        pos("USDC", "999000000", 6, { flags: { is_trash: true } }),
        pos("USDC", "999000000", 6, { fungible_info: { symbol: "USDC", flags: { verified: false } } }),
        pos("USDC", "999000000", 6, { position_type: "deposit" }),
        pos("ETH", "1000000000000000000", 18, { price: 3000 }),
      ],
    });
    assert.equal(micros, 3_350_250_000);
  });

  it("transactions: rows and whether there is another page", () => {
    const page = parseTransactions({
      links: { self: "s", next: "https://api.zerion.io/v1/wallets/0x/transactions/?page%5Bafter%5D=x" },
      data: [{ attributes: { mined_at: "2025-01-01T00:00:00Z", operation_type: "trade", status: "confirmed", flags: { is_trash: false } }, relationships: { chain: { data: { id: "base" } } } }],
    });
    assert.equal(page.hasNext, true);
    assert.deepEqual(page.rows[0], { minedAt: 1735689600, operationType: "trade", status: "confirmed", chainId: "base", trash: false });
    assert.throws(() => parseTransactions({ data: [{ attributes: { mined_at: "?" } }] }), ParseError);
  });

  it("recognises 'not trackable' as a known empty", () => {
    assert.equal(isNotTrackable(400, { errors: [{ title: "Parameter error", detail: "address 0xabc is not trackable" }] }), true);
    assert.equal(isNotTrackable(400, { errors: [{ title: "bad", detail: "invalid filter" }] }), false);
    assert.equal(isNotTrackable(500, {}), false);
  });

  it("requests keep the trailing slash, 13-digit milliseconds and Zerion's bracket encoding", () => {
    const r = zerionRequests.transactions("0xABC0000000000000000000000000000000000001", { testnet: true, chainIds: ["monad-test-v2"], maxMinedAt: 1704164645, pageSize: 1 });
    assert.match(r.url, /\/v1\/wallets\/0xabc0000000000000000000000000000000000001\/transactions\/\?/);
    assert.match(r.url, /filter%5Bchain_ids%5D=monad-test-v2/);
    assert.match(r.url, /filter%5Bmax_mined_at%5D=1704164645000/);
    assert.equal(r.headers["X-Env"], "testnet");
    assert.equal(zerionAuthorization("zk_dev_123"), "Basic emtfZGV2XzEyMzo=");
  });
});

describe("Etherscan parsers", () => {
  const log = (address: string) => ({ address, topics: [], data: "0x", blockNumber: "0x1", timeStamp: "0x1", gasPrice: "0x", gasUsed: "0x", logIndex: "0x", transactionHash: "0x", transactionIndex: "0x" });

  it("counts only liquidations emitted by an allowlisted pool: a spoofed event does not hurt the buyer", () => {
    const pool = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
    assert.equal(parseLiquidationCount({ status: "1", message: "OK", result: [log(pool.toLowerCase()), log("0xbad0000000000000000000000000000000000001")] }, [pool]), 1);
  });

  it("reads 'No records found' as zero and anything else unexpected as an error", () => {
    assert.equal(parseLiquidationCount({ status: "0", message: "No records found", result: [] }, []), 0);
    assert.throws(() => parseLiquidationCount({ status: "0", message: "NOTOK", result: "Invalid API Key" }, []), /Invalid API Key/);
  });

  it("token transfers: the first one and the count", () => {
    assert.deepEqual(parseTokenTransfers({ status: "1", message: "OK", result: [{ timeStamp: "200" }, { timeStamp: "100" }] }), { firstAt: 100, count: 2 });
  });

  it("builds the topic query for the borrower, with no key in the URL", () => {
    const r = etherscanRequests.liquidationLogs(1, "0xB0B0000000000000000000000000000000000003");
    assert.match(r.url, /topic3=0x000000000000000000000000b0b0000000000000000000000000000000000003/);
    assert.doesNotMatch(r.url, /apikey/);
  });
});

describe("small pieces", () => {
  it("rpc: hex quantities, errors surfaced", () => {
    assert.equal(parseRpcQuantity({ jsonrpc: "2.0", id: 1, result: "0x1a" }), 26n);
    assert.equal(parseRpcQuantity({ jsonrpc: "2.0", id: 1, result: "0x" }), 0n);
    assert.throws(() => parseRpcQuantity({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }), /boom/);
  });

  it("labels: exchanges by whole name, risk by pattern, victims are not risks", () => {
    assert.equal(exchangeIn("Coinbase: Hot Wallet 2"), "Coinbase");
    assert.equal(exchangeIn("binance 14"), "Binance");
    assert.equal(exchangeIn("OKX: Deposit"), "OKX");
    assert.equal(exchangeIn("Rokx Labs"), null);
    assert.equal(exchangeIn(null), null);
    assert.equal(riskIn("Tornado Cash: Router"), "Tornado Cash: Router");
    assert.equal(riskIn("Euler Exploiter"), "Euler Exploiter");
    assert.equal(riskIn("Fake_Phishing1234"), "Fake_Phishing1234");
    assert.equal(riskIn("Phishing victim"), null);
    assert.equal(riskIn("ETHGlobal Hackathon Winner"), null);
    assert.equal(riskIn("Community Faucet"), null);
  });

  it("base64 without Buffer, query strings, binary search", () => {
    assert.equal(base64Ascii("key:"), "a2V5Og==");
    assert.equal(base64Ascii("ab"), "YWI=");
    assert.equal(queryString([["filter[a]", "x,y"], ["skip", undefined], ["n", 1]]), "filter%5Ba%5D=x%2Cy&n=1");
    const probes: number[] = [];
    assert.equal(largestHit([30, 90, 180, 365, 730, 900], (d) => (probes.push(d), d <= 400)), 365);
    assert.ok(probes.length <= 3, "three probes at most over six edges");
    assert.equal(largestHit([30, 90], () => false), null);
  });
});
