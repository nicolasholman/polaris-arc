/**
 * The recipe end to end on fixtures: evidence from the providers, Facts from
 * the evidence, the decision from the Facts. One test per persona, then one
 * per failure the providers can throw at us.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "../src/core/types.ts";
import { underwrite, type UnderwriteOutcome } from "../src/core/underwrite.ts";
import { collectAccount, collectLinked, type Issue, type Providers } from "../src/node/collect.ts";
import { fixtureTransport } from "../src/testing/fixtures.ts";
import { ACCOUNT, fixtureProviders, host, LINKED, networkDown, NOW, scripted, status } from "./helpers.ts";

async function run(
  p: Providers,
  account: Address,
  linked: Address | null,
  opts: { purchase?: bigint; allowPartial?: boolean; useNansenLabels?: boolean } = {},
): Promise<UnderwriteOutcome & { issues: Issue[] }> {
  const o = { now: NOW, useNansenLabels: opts.useNansenLabels };
  const [a, l] = await Promise.all([collectAccount(account, p, o), linked ? collectLinked(linked, p, o) : null]);
  const out = underwrite({
    user: account,
    observedAt: NOW,
    account: a.evidence,
    linked: l?.evidence ?? null,
    linkVerified: true,
    purchase: opts.purchase ?? null,
    options: { allowPartial: opts.allowPartial },
  });
  return { ...out, issues: [...a.issues, ...(l?.issues ?? [])] };
}

const reason = (o: UnderwriteOutcome, id: string) => o.decision.reasons.find((r) => r.id === id);

describe("personas", () => {
  it("thin file: a three-day-old account is not attested, so it opens no unsecured line, and is told the way in", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, null, { purchase: 200_000_000n });
    assert.equal(o.final, true);
    assert.equal(o.attest, false);
    assert.equal(o.report, null, "a report would open ScoreManager's $200 floor on no evidence");
    assert.deepEqual(o.facts, {
      walletAgeDays: 3,
      txCount: 2,
      stableBalance: 37_600_000n,
      defiTenureDays: 0,
      priorLiquidations: 0,
      relatedWallets: 0,
      exchangeFunded: false,
      observedAt: BigInt(NOW),
    });
    assert.equal(o.breakdown.score, 520);
    assert.equal(o.decision.limit, 0n);
    assert.equal(o.decision.payIn4.allowed, false);
    assert.deepEqual(o.decision.thinFile?.map((g) => g.fact), ["walletAgeDays", "txCount"]);
    assert.deepEqual(o.decision.nextSteps.map((s) => s.id), ["link-history", "build-history", "secure"]);
  });

  it("regular file: an account with three months of its own use clears the floor and opens at $200", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.regular, null, { purchase: 150_000_000n });
    assert.equal(o.final, true);
    assert.equal(o.attest, true);
    assert.equal(o.facts.walletAgeDays, 90);
    assert.equal(o.decision.limit, 200_000_000n);
    assert.equal(o.decision.payIn4.allowed, true);
    assert.match(o.report ?? "", /^0x[0-9a-f]{832}$/);
  });

  it("strong file: Nansen's facts open a $1,000 line, and the reasons say so", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.strong, { purchase: 600_000_000n });
    assert.equal(o.final, true);
    assert.equal(o.facts.walletAgeDays, 1210);
    assert.equal(o.facts.exchangeFunded, true);
    assert.equal(o.breakdown.score, 692);
    assert.equal(o.decision.limit, 1_000_000_000n);
    assert.equal(o.decision.payIn4.allowed, true);
    assert.equal(o.decision.payIn4.quote?.fits, true);
    assert.equal(reason(o, "age")?.text, "You've used your linked account for 3 years · +60");
    assert.equal(reason(o, "age")?.provider, "nansen");
    assert.equal(reason(o, "exchange")?.text, "First topped up from Coinbase, a major exchange · +10");
    assert.equal(reason(o, "liquidations")?.provider, "etherscan");
    assert.equal(o.derivation.attribution.stableBalance.source, "zerion.positions");
    assert.match(o.report ?? "", /^0x[0-9a-f]{832}$/, "one item in the receiver's batch: 96 + 320 bytes");
  });

  it("modest file: a small circle of accounts from one funder costs points, not the line", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.modest);
    assert.equal(o.facts.relatedWallets, 6);
    assert.equal(o.breakdown.cluster, -6);
    assert.equal(o.breakdown.declined, false);
    assert.equal(reason(o, "cluster")?.text, "Set up from the same source as 6 other accounts · −6");
    assert.equal(reason(o, "cluster")?.provider, "nansen");
  });

  it("two past liquidations decline, and the spoofed third does not count", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.liquidated);
    assert.equal(o.facts.priorLiquidations, 2);
    assert.equal(o.breakdown.declined, true);
    assert.equal(o.decision.limit, 0n);
    assert.equal(o.decision.declineReason, "Two or more past loans elsewhere were closed by the lender.");
    assert.equal(o.final, true, "a decline is reported too: the contract records it");
  });

  it("a sybil cluster declines", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.sybil);
    assert.equal(o.facts.relatedWallets, 30);
    assert.deepEqual(o.breakdown.declinedFor, ["cluster"]);
    assert.match(o.decision.declineReason ?? "", /one of many set up by the same person/);
  });

  it("risky label: a wallet first funded through a mixer is not counted, and the buyer is told", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.tainted);
    assert.equal(o.derivation.linked?.excludedFor, "risk-label");
    assert.equal(o.derivation.linked?.riskLabel, "Tornado Cash: Router");
    assert.equal(o.facts.stableBalance, 37_600_000n, "its $9,000 does not count");
    assert.equal(o.breakdown.score, 520);
    assert.equal(o.final, true);
    assert.match(reason(o, "linked-excluded")?.label ?? "", /couldn't count your linked account/);
  });

  it("risky label from Nansen's labels endpoint, when enabled", async () => {
    const t = scripted(fixtureTransport(), [
      {
        match: host("nansen", "/labels"),
        respond: () => status(200, { pagination: { page: 1, per_page: 100, is_last_page: true }, data: [{ label: "Euler Exploiter", category: "behavioral", kind: [] }] }),
      },
    ]);
    const o = await run(fixtureProviders(t), ACCOUNT.fresh, LINKED.strong, { useNansenLabels: true });
    assert.equal(o.derivation.linked?.excludedFor, "risk-label");
    assert.equal(o.derivation.linked?.riskLabel, "Euler Exploiter");
  });

  it("no first funder on record: Zerion probes date the wallet, as a floor", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.noFunder);
    assert.equal(o.final, true);
    assert.equal(o.facts.walletAgeDays, 365);
    assert.equal(o.derivation.attribution.walletAgeDays.source, "zerion.probe");
    assert.equal(reason(o, "age")?.text, "You've used your linked account for over a year · +24");
  });

  it("a faucet with 100+ wallets is infrastructure, not a cluster", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.infra);
    assert.equal(o.facts.relatedWallets, 0);
    assert.equal(o.derivation.infrastructureFunder, true);
    assert.equal(reason(o, "cluster")?.label, "First topped up from a service many people use");
  });

  it("an address Zerion cannot track falls back to Nansen's balance", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, LINKED.exchangeWallet);
    assert.equal(o.final, true);
    assert.equal(o.derivation.attribution.stableBalance.source, "nansen.current-balance");
    assert.equal(o.facts.stableBalance, 1_250_500_000n + 37_600_000n);
    assert.equal(o.facts.defiTenureDays, 0);
  });

  it("an account Zerion has no record of is dated by Etherscan's token transfers", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.zerionBlind, null);
    assert.equal(o.final, true);
    assert.equal(o.facts.walletAgeDays, 45);
    assert.equal(o.facts.txCount, 3);
    assert.equal(o.derivation.attribution.walletAgeDays.source, "etherscan.tokentx");
    assert.equal(o.derivation.attribution.walletAgeDays.status, "fallback");
  });

  it("an account with more than a page of history is dated with probes, not paging", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.regular, null);
    assert.equal(o.final, true);
    assert.equal(o.facts.txCount, 100, "a full page proves at least 100");
    assert.equal(o.facts.walletAgeDays, 90, "its oldest transfer is 130 days old; the probes prove over 90");
    assert.equal(o.derivation.attribution.walletAgeDays.source, "zerion.probe");
    assert.equal(reason(o, "age")?.text, "You've used this account for over 3 months · +6");
    assert.equal(reason(o, "activity")?.text, "You've made 100 payments and transfers · +4");
  });

  it("an account whose history fits one page gets its exact age", async () => {
    const o = await run(fixtureProviders(), ACCOUNT.fresh, null);
    assert.equal(o.derivation.attribution.walletAgeDays.source, "zerion.transactions");
    assert.equal(o.derivation.attribution.walletAgeDays.lowerBound, false);
  });
});

describe("provider failures and fallback", () => {
  it("Nansen down: Zerion dates the wallet, but the cluster check cannot run, so the wallet waits and nothing is reported", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("api.nansen.ai"), respond: () => status(500, { code: "internal" }) }]);
    const p = fixtureProviders(t);
    const o = await run(p, ACCOUNT.fresh, LINKED.strong);
    assert.equal(o.final, false);
    assert.equal(o.report, null);
    assert.ok(o.missing.includes("linked.funder"));
    assert.ok(o.missing.includes("linked.relatedWallets"));
    assert.equal(o.derivation.linked?.excludedFor, "missing-risk-check");
    assert.equal(o.decision.limit, 0n, "the preview never shows an unchecked $1,000, and the account alone is too thin for a line");
    assert.equal(o.decision.headline, "We're finishing a check on your history.");
    assert.ok(o.issues.some((i) => i.source === "nansen.first-funder" && i.code === "server_error"));
    const nansenCalls = t.calls.filter((c) => c.url.includes("nansen") && c.url.includes("first-funder")).length;
    assert.equal(nansenCalls, 3, "retried three times, then fell back");
    assert.ok(p.clock.slept.length > 0, "with backoff between tries");
  });

  it("Nansen out of credits: no retries, same safe outcome", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("api.nansen.ai"), respond: () => status(403, { code: "insufficient_credits", message: "no credits" }) }]);
    const o = await run(fixtureProviders(t), ACCOUNT.fresh, LINKED.strong);
    assert.equal(o.final, false);
    assert.equal(t.calls.filter((c) => c.url.includes("first-funder")).length, 1);
    assert.ok(o.issues.some((i) => i.code === "insufficient_credits"));
  });

  it("Nansen rate-limits once, then answers: the wait is honoured and the report is final", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("api.nansen.ai", "first-funder"), times: 1, respond: () => status(429, { code: "rate_limit_exceeded" }, { "retry-after": "1" }) }]);
    const p = fixtureProviders(t);
    const o = await run(p, ACCOUNT.fresh, LINKED.strong);
    assert.equal(o.final, true);
    assert.equal(o.breakdown.score, 692);
    assert.ok(p.clock.slept.includes(1000));
  });

  it("Nansen down with allowPartial: reported on the account alone", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("api.nansen.ai"), respond: networkDown }]);
    const o = await run(fixtureProviders(t), ACCOUNT.fresh, LINKED.strong, { allowPartial: true });
    assert.equal(o.final, true);
    assert.equal(o.derivation.linked?.used, false);
    assert.equal(o.breakdown.score, 520);
  });

  it("Zerion down: Nansen supplies the balance and the trading history", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("api.zerion.io"), respond: () => status(503, {}) }]);
    const o = await run(fixtureProviders(t), ACCOUNT.regular, LINKED.strong);
    assert.equal(o.derivation.attribution.stableBalance.source, "nansen.current-balance");
    assert.equal(o.derivation.attribution.defiTenureDays.source, "nansen.transactions");
    assert.equal(o.derivation.attribution.walletAgeDays.source, "nansen.first-funder");
    // The account's own history has no second source in fixtures, so it waits.
    assert.equal(o.final, false);
    assert.ok(o.missing.includes("account.firstSeenAt"));
  });

  it("Etherscan down: past loans cannot be checked, so the linked wallet waits", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("etherscan", "getLogs"), respond: () => status(502, {}) }]);
    const o = await run(fixtureProviders(t), ACCOUNT.fresh, LINKED.strong);
    assert.equal(o.final, false);
    assert.deepEqual(o.missing, ["linked.liquidations"]);
    assert.equal(o.derivation.linked?.excludedFor, "missing-risk-check");
  });

  it("RPC nonces down: Zerion's count stands in, capped at a page", async () => {
    const t = scripted(fixtureTransport(), [{ match: (r) => r.body?.includes("eth_getTransactionCount") ?? false, respond: networkDown }]);
    const o = await run(fixtureProviders(t), ACCOUNT.fresh, LINKED.strong);
    assert.equal(o.final, true);
    assert.equal(o.derivation.attribution.txCount.source, "zerion.transactions");
    assert.equal(o.facts.txCount, 9 + 2, "nine counted rows (the trash airdrop is not activity) plus the account's two");
  });

  it("everything down: nothing is reported, and the preview is the floor", async () => {
    const t = scripted(fixtureTransport(), [{ match: () => true, respond: networkDown }]);
    const o = await run(fixtureProviders(t), ACCOUNT.fresh, LINKED.strong);
    assert.equal(o.final, false);
    assert.equal(o.report, null);
    assert.equal(o.decision.limit, 0n, "nothing read is nothing to lend on");
    assert.ok(o.missing.includes("account.stableBalance"));
  });

  it("a malformed Nansen body is a failure, not an empty answer", async () => {
    const t = scripted(fixtureTransport(), [{ match: host("nansen", "first-funder"), respond: () => status(200, { data: [{ unexpected: true }] }) }]);
    const o = await run(fixtureProviders(t), ACCOUNT.fresh, LINKED.strong);
    assert.equal(o.final, false);
    assert.ok(o.issues.some((i) => i.code === "parse_error"));
  });
});
