import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { decodeUnderwritingReport } from "../src/core/abi.ts";
import { linkMessage } from "../src/core/link.ts";
import type { Address, KeyedProvider } from "../src/core/types.ts";
import { fixtureTransport } from "../src/testing/fixtures.ts";
import type { HttpTransport } from "../src/node/http.ts";
import { NansenClient } from "../src/node/nansen.ts";
import { accountChainFromEnv, CreditMeter, Underwriter } from "../src/node/service.ts";
import { ARC_MAINNET, ARC_TESTNET } from "../src/core/constants.ts";
import { ACCOUNT, fixtureProviders, host, LINKED, networkDown, NOW, scripted, TEST_KEYS } from "./helpers.ts";

// A throwaway key generated for this test; it controls nothing.
const OWNER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

async function proofFor(account: Address, wallet = OWNER, issuedAt = NOW - 60, nonce = "n0nce-12345") {
  const signature = await wallet.signMessage({ message: linkMessage({ account, wallet: wallet.address, issuedAt, nonce }) });
  return { issuedAt, nonce, signature };
}

/** Providers on fixtures, with the throwaway owner's address read as the strong persona's history. */
function underwriterOn(transport: HttpTransport = fixtureTransport(), meter = new CreditMeter(), notConfigured: KeyedProvider[] = []) {
  const from = OWNER.address.toLowerCase();
  const alias = (s: string) => s.replaceAll(from, LINKED.strong).replaceAll(from.slice(2), LINKED.strong.slice(2));
  const t: HttpTransport = (req, signal) => transport({ ...req, url: alias(req.url), body: req.body && alias(req.body) }, signal);
  const p = fixtureProviders(t, { notConfigured });
  p.nansen = new NansenClient({
    apiKey: notConfigured.includes("nansen") ? undefined : TEST_KEYS.nansen,
    transport: t,
    clock: p.clock,
    cacheTtlMs: 0,
    onResponse: (_s, res) => meter.record(res.headers),
  });
  return new Underwriter({ providers: p, now: () => NOW, creditMeter: meter });
}

describe("Underwriter.assess", () => {
  it("a proven linked wallet is final, carries a report ScoreManager can decode, and costs one Nansen credit", async () => {
    const meter = new CreditMeter();
    const uw = underwriterOn(fixtureTransport(), meter);
    const a = await uw.assess({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address, proof: await proofFor(ACCOUNT.fresh) }, purchase: 200_000_000n });
    assert.deepEqual(a.linkProof, { verified: true, reason: null });
    assert.equal(a.final, true);
    assert.equal(a.breakdown.score, 692);
    assert.deepEqual(a.providers, { nansen: "live", zerion: "live", etherscan: "live", rpc: "live", blockscout: "live" });
    assert.deepEqual(a.notConfigured, []);
    assert.deepEqual(a.absent, []);
    assert.equal(a.retryAfterSeconds, null);
    assert.equal(a.credits.nansen, 1, "first-funder only: an exchange-funded wallet skips related-wallets");
    const r = decodeUnderwritingReport(a.report!);
    assert.equal(r.kind, 2);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.user, ACCOUNT.fresh.toLowerCase());
    assert.equal(r.items[0]!.linkedWallet, OWNER.address.toLowerCase(), "the receiver needs the wallet to hold it to one account");
    assert.equal(a.linkedWallet?.toLowerCase(), OWNER.address.toLowerCase());
    assert.deepEqual(r.items[0]!.facts, a.facts);
    assert.equal(a.facts.observedAt, BigInt(NOW));
  });

  it("without a proof, the linked wallet is only a preview", async () => {
    const a = await underwriterOn().assess({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address } });
    assert.equal(a.final, false);
    assert.deepEqual(a.missing, ["linked.ownership"]);
    assert.equal(a.report, null);
    assert.equal(a.retryAfterSeconds, null, "waiting will not help; the buyer has to confirm");
    assert.equal(a.linkProof?.reason, "no ownership proof");
  });

  it("a proof signed by another wallet does not count", async () => {
    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const forged = await proofFor(ACCOUNT.fresh, other);
    const a = await underwriterOn().assess({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address, proof: forged } });
    assert.equal(a.linkProof?.verified, false);
    assert.equal(a.final, false);
  });

  it("a proof for another Polaris account does not count", async () => {
    const a = await underwriterOn().assess({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address, proof: await proofFor(ACCOUNT.regular) } });
    assert.equal(a.linkProof?.verified, false);
  });

  it("a stale proof does not count", async () => {
    const a = await underwriterOn().assess({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address, proof: await proofFor(ACCOUNT.fresh, OWNER, NOW - 3600) } });
    assert.deepEqual(a.linkProof, { verified: false, reason: "proof older than 15 minutes" });
  });

  it("tells the app when to retry when a provider is down", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("api.nansen.ai"), respond: networkDown }]);
    const a = await underwriterOn(t).assess({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address, proof: await proofFor(ACCOUNT.fresh) } });
    assert.equal(a.final, false);
    assert.ok((a.retryAfterSeconds ?? 0) >= 30);
    assert.ok(a.issues.every((i) => !JSON.stringify(i).includes("apikey")));
  });

  it("builds from the environment: live with a key, not configured without, public RPCs always live", () => {
    const none = Underwriter.fromEnv({});
    assert.deepEqual(none.modes(), { nansen: "not_configured", zerion: "not_configured", etherscan: "not_configured", rpc: "live", blockscout: "live" });
    assert.deepEqual(none.notConfigured(), [
      { provider: "nansen", env: "NANSEN_API_KEY" },
      { provider: "zerion", env: "ZERION_API_KEY" },
      { provider: "etherscan", env: "ETHERSCAN_API_KEY" },
    ]);
    const some = Underwriter.fromEnv({ ETHERSCAN_API_KEY: "ek", NANSEN_API_KEY: "" });
    assert.deepEqual(some.modes(), { nansen: "not_configured", zerion: "not_configured", etherscan: "live", rpc: "live", blockscout: "live" });
    assert.equal(Underwriter.fromEnv({ NANSEN_API_KEY: "nk", UNDERWRITING_MODE: "live" }).modes().nansen, "live");
  });

  it("refuses UNDERWRITING_MODE=fixture: nothing is ever synthesized", () => {
    assert.throws(() => Underwriter.fromEnv({ UNDERWRITING_MODE: "fixture" }), /UNDERWRITING_MODE=fixture is not supported.*NANSEN_API_KEY/);
  });
});

describe("Underwriter.assess with providers not configured", () => {
  it("without NANSEN_API_KEY a linked wallet can't be checked: not final, nothing to retry, Nansen named, nothing invented", async () => {
    const t = scripted(fixtureTransport(), []);
    const uw = underwriterOn(t, new CreditMeter(), ["nansen"]);
    const a = await uw.assess({ account: ACCOUNT.fresh, linked: { wallet: OWNER.address, proof: await proofFor(ACCOUNT.fresh) } });
    assert.equal(t.calls.some((c) => c.url.includes("api.nansen.ai")), false, "no request to Nansen, and nothing answers for it");
    assert.equal(a.providers.nansen, "not_configured");
    assert.deepEqual(a.notConfigured, [{ provider: "nansen", env: "NANSEN_API_KEY" }]);
    assert.equal(a.final, false);
    assert.equal(a.attest, false);
    assert.equal(a.report, null);
    assert.equal(a.unavailable, true);
    assert.equal(a.retryAfterSeconds, null, "asking again can't help until the key is set");
    assert.deepEqual(a.missing.sort(), ["linked.funder", "linked.relatedWallets", "linked.riskLabel"]);
    assert.ok(a.absent.includes("linked.funder"));
    assert.equal(a.evidence.linked?.funder.status, "not_configured");
    assert.equal(a.evidence.linked?.funder.value, null);
    assert.equal(a.derivation.linked?.excludedFor, "missing-risk-check");
    assert.equal(a.decision.headline.endsWith("Credit reviews aren't fully set up here yet."), true, a.decision.headline);
    assert.equal(a.decision.reasons.find((r) => r.id === "linked-excluded")?.label, "We can't check your linked account here yet, so it doesn't count");
    assert.ok(a.issues.some((i) => i.code === "not_configured" && /NANSEN_API_KEY is not set/.test(i.message)));
  });

  it("the account alone needs no keyed provider: Arc's RPC and explorer answer, and it may be attested", async () => {
    const t = scripted(fixtureTransport(), []);
    const a = await underwriterOn(t, new CreditMeter(), ["nansen", "zerion", "etherscan"]).assess({ account: ACCOUNT.regular });
    assert.equal(
      t.calls.every((c) => !/api\.(nansen\.ai|zerion\.io|etherscan\.io)/.test(c.url)),
      true,
      "only Arc's public RPC and explorer are asked",
    );
    assert.deepEqual(a.notConfigured, [], "nothing the account needs is keyed");
    assert.deepEqual(a.absent, []);
    assert.equal(a.evidence.account.sentCount.source, "blockscout.tokentx");
    assert.equal(a.evidence.account.firstSeenAt.source, "blockscout.tokentx");
    assert.equal(a.final, true);
    assert.equal(a.attest, true, "130 days and 67 transfers clear the thin-file gate");
    assert.equal(a.decision.limit, 200_000_000n);
  });

  it("with no explorer for the account chain, the account's age is absent: no points, and never called a thin file", async () => {
    const t = scripted(fixtureTransport(), []);
    const uw = underwriterOn(t, new CreditMeter(), ["nansen", "zerion", "etherscan"]);
    const local = new Underwriter({ providers: { ...uw.providers, explorer: null }, now: () => NOW });
    const a = await local.assess({ account: ACCOUNT.selfPaying });
    assert.equal(t.calls.some((c) => c.url.includes("explorer")), false);
    assert.equal(local.modes().blockscout, "not_configured");
    assert.deepEqual(a.absent, ["account.firstSeenAt"]);
    assert.equal(a.facts.walletAgeDays, 0, "absent, not counted");
    assert.equal(a.facts.txCount, 3, "the nonce still counts");
    assert.equal(a.final, true, "nothing to wait for");
    assert.equal(a.attest, false, "too thin to attest");
    assert.equal(a.unavailable, true, "thin only for want of an explorer");
    assert.equal(a.decision.nextSteps.some((s) => s.id === "build-history"), false, "no promise about when it opens");
  });
});

describe("accountChainFromEnv", () => {
  it("defaults to Arc testnet: its RPC, its explorer, USDC and EURC", () => {
    assert.deepEqual(accountChainFromEnv({}), {
      chainId: ARC_TESTNET.chainId,
      rpcUrl: ARC_TESTNET.rpcUrl,
      explorerApiUrl: ARC_TESTNET.explorerApiUrl,
      tokens: [ARC_TESTNET.usdc, ARC_TESTNET.eurc],
    });
  });

  it("knows Arc mainnet by its chain id, and takes overrides", () => {
    const main = accountChainFromEnv({ UNDERWRITING_ACCOUNT_CHAIN_ID: "5042" });
    assert.equal(main.rpcUrl, ARC_MAINNET.rpcUrl);
    assert.equal(main.explorerApiUrl, ARC_MAINNET.explorerApiUrl);
    assert.deepEqual(main.tokens, [ARC_MAINNET.usdc, ARC_MAINNET.eurc]);
    const own = accountChainFromEnv({ UNDERWRITING_ACCOUNT_RPC_URL: "https://my-arc-node.example", UNDERWRITING_ACCOUNT_EXPLORER_API_URL: "none" });
    assert.equal(own.rpcUrl, "https://my-arc-node.example");
    assert.equal(own.explorerApiUrl, null);
  });

  it("a custom chain (a local node) needs its RPC and its dollar tokens, and has no explorer unless given one", () => {
    assert.throws(() => accountChainFromEnv({ UNDERWRITING_ACCOUNT_CHAIN_ID: "31337" }), /UNDERWRITING_ACCOUNT_RPC_URL is required/);
    assert.throws(() => accountChainFromEnv({ UNDERWRITING_ACCOUNT_CHAIN_ID: "31337", UNDERWRITING_ACCOUNT_RPC_URL: "http://127.0.0.1:8600" }), /UNDERWRITING_ACCOUNT_TOKENS is required/);
    assert.throws(() => accountChainFromEnv({ UNDERWRITING_ACCOUNT_CHAIN_ID: "x" }), /not a chain id/);
    const local = accountChainFromEnv({
      UNDERWRITING_ACCOUNT_CHAIN_ID: "31337",
      UNDERWRITING_ACCOUNT_RPC_URL: "http://127.0.0.1:8600",
      UNDERWRITING_ACCOUNT_TOKENS: "0x5FbDB2315678afecb367f032d93F642f64180aa3, 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    });
    assert.deepEqual(local, {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8600",
      explorerApiUrl: null,
      tokens: ["0x5FbDB2315678afecb367f032d93F642f64180aa3", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"],
    });
    assert.equal(Underwriter.fromEnv({ UNDERWRITING_ACCOUNT_CHAIN_ID: "31337", UNDERWRITING_ACCOUNT_RPC_URL: "http://127.0.0.1:8600", UNDERWRITING_ACCOUNT_TOKENS: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }).modes().blockscout, "not_configured");
  });
});
