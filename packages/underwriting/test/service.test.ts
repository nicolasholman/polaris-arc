import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { decodeUnderwritingReport } from "../src/core/abi.ts";
import { linkMessage } from "../src/core/link.ts";
import type { Address, KeyedProvider } from "../src/core/types.ts";
import { fixtureTransport } from "../src/testing/fixtures.ts";
import type { HttpTransport } from "../src/node/http.ts";
import { NansenClient } from "../src/node/nansen.ts";
import { CreditMeter, Underwriter } from "../src/node/service.ts";
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
    assert.deepEqual(a.providers, { nansen: "live", zerion: "live", etherscan: "live", rpc: "live" });
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
    assert.deepEqual(none.modes(), { nansen: "not_configured", zerion: "not_configured", etherscan: "not_configured", rpc: "live" });
    assert.deepEqual(none.notConfigured(), [
      { provider: "nansen", env: "NANSEN_API_KEY" },
      { provider: "zerion", env: "ZERION_API_KEY" },
      { provider: "etherscan", env: "ETHERSCAN_API_KEY" },
    ]);
    const some = Underwriter.fromEnv({ ETHERSCAN_API_KEY: "ek", NANSEN_API_KEY: "" });
    assert.deepEqual(some.modes(), { nansen: "not_configured", zerion: "not_configured", etherscan: "live", rpc: "live" });
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

  it("the account alone needs no Nansen or Zerion: Etherscan's transfers answer, the rest is absent, and it may be attested", async () => {
    const t = scripted(fixtureTransport(), []);
    const a = await underwriterOn(t, new CreditMeter(), ["nansen", "zerion"]).assess({ account: ACCOUNT.zerionBlind });
    assert.equal(t.calls.some((c) => c.url.includes("api.zerion.io") || c.url.includes("api.nansen.ai")), false);
    assert.deepEqual(a.notConfigured, [{ provider: "zerion", env: "ZERION_API_KEY" }]);
    assert.equal(a.final, true);
    assert.equal(a.evidence.account.sentCount.source, "etherscan.tokentx");
    assert.equal(a.evidence.account.sentCount.status, "fallback");
    assert.deepEqual(a.absent, []);
  });

  it("with no keyed provider at all, the account's history is absent: no points, and never called a thin file", async () => {
    const t = scripted(fixtureTransport(), []);
    const a = await underwriterOn(t, new CreditMeter(), ["nansen", "zerion", "etherscan"]).assess({ account: ACCOUNT.regular });
    assert.equal(
      t.calls.every((c) => !/api\.(nansen\.ai|zerion\.io|etherscan\.io)/.test(c.url)),
      true,
      "only the public RPC is asked",
    );
    assert.deepEqual(
      a.notConfigured.map((n) => n.env),
      ["ZERION_API_KEY", "ETHERSCAN_API_KEY"],
    );
    assert.deepEqual(a.absent.sort(), ["account.firstSeenAt", "account.sentCount"]);
    assert.equal(a.evidence.account.sentCount.status, "not_configured");
    assert.equal(a.facts.txCount, 0, "absent, not counted");
    assert.equal(a.facts.walletAgeDays, 0);
    assert.equal(a.final, true, "nothing to wait for");
    assert.equal(a.attest, false, "too thin to attest");
    assert.equal(a.unavailable, true, "thin only for want of keys");
    assert.equal(a.decision.headline, "Credit reviews aren't fully set up here yet.");
    assert.equal(a.decision.nextSteps.some((s) => s.id === "build-history"), false, "no promise about when it opens");
    assert.ok(a.decision.reasons.some((r) => r.label === "Some of this account's history can't be read here yet, so it doesn't count"));
  });
});
