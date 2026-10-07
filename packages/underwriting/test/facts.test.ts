import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeUnderwritingReport, encodeUnderwritingReport } from "../src/core/abi.ts";
import { attestGaps, isAttestable } from "../src/core/attest.ts";
import { ATTEST_MINIMUM, DAY_SECONDS, FACTS_VERSION, U16_MAX, U32_MAX, U64_MAX } from "../src/core/constants.ts";
import { decide } from "../src/core/decision.ts";
import { accountRules, evidence } from "../src/core/evidence.ts";
import { deriveFacts } from "../src/core/facts.ts";
import { scoreBreakdown } from "../src/core/score.ts";
import type { Address, Funder, SubjectEvidence } from "../src/core/types.ts";
import { explainOnChainFacts, underwrite } from "../src/core/underwrite.ts";

const NOW = 1_790_424_000;
const ACCOUNT = "0xacc0000000000000000000000000000000000001" as Address;
const WALLET = "0xb0b0000000000000000000000000000000000001" as Address;
const days = (n: number) => NOW - n * DAY_SECONDS;

function account(o: Partial<SubjectEvidence> = {}): SubjectEvidence {
  return {
    address: ACCOUNT,
    role: "account",
    firstSeenAt: evidence.ok<number | null>(days(3), "zerion.transactions"),
    sentCount: evidence.ok(2, "zerion.transactions"),
    stableBalance: evidence.ok(37_600_000, "rpc.balance"),
    ...accountRules(),
    ...o,
  };
}

/** An account with a few months of its own history: over the evidence floor with no linked wallet. */
const seasoned = (o: Partial<SubjectEvidence> = {}) =>
  account({ firstSeenAt: evidence.ok<number | null>(days(90), "zerion.transactions"), sentCount: evidence.ok(12, "zerion.transactions"), ...o });

const coinbase: Funder = { address: "0xc0ba5e0000000000000000000000000000000002", name: "Coinbase: Hot Wallet 2", chain: "ethereum", fundedAt: days(1210) };
const peer: Funder = { address: "0xfeed000000000000000000000000000000000002", name: null, chain: "base", fundedAt: days(200) };

function linked(o: Partial<SubjectEvidence> = {}, funder: Funder | null = peer): SubjectEvidence {
  return {
    address: WALLET,
    role: "linked",
    firstSeenAt: evidence.ok<number | null>(funder?.fundedAt ?? days(400), "nansen.first-funder"),
    sentCount: evidence.ok(900, "rpc.nonce"),
    stableBalance: evidence.ok(4_200_250_000, "zerion.positions"),
    defiSince: evidence.ok<number | null>(days(730), "zerion.probe"),
    liquidations: evidence.ok(0, "etherscan.logs"),
    funder: evidence.ok<Funder | null>(funder, "nansen.first-funder"),
    relatedWallets: evidence.ok(0, "nansen.related-wallets"),
    riskLabel: evidence.ok<string | null>(null, "nansen.first-funder"),
    ...o,
  };
}

describe("deriveFacts v1", () => {
  it("scores the account alone on its own history", () => {
    const d = deriveFacts({ account: account(), observedAt: NOW });
    assert.deepEqual(d.facts, {
      walletAgeDays: 3,
      txCount: 2,
      stableBalance: 37_600_000n,
      defiTenureDays: 0,
      priorLiquidations: 0,
      relatedWallets: 0,
      exchangeFunded: false,
      observedAt: BigInt(NOW),
    });
    assert.equal(d.final, true);
    assert.equal(d.version, FACTS_VERSION);
    assert.equal(d.linked, null);
  });

  it("merges a linked wallet: the older age, summed activity and dollars, its tenure and funding", () => {
    const d = deriveFacts({ account: account(), linked: linked({}, coinbase), observedAt: NOW });
    assert.equal(d.facts.walletAgeDays, 1210);
    assert.equal(d.facts.txCount, 902);
    assert.equal(d.facts.stableBalance, 4_237_850_000n);
    assert.equal(d.facts.defiTenureDays, 730);
    assert.equal(d.facts.exchangeFunded, true);
    assert.equal(d.exchange, "Coinbase");
    assert.equal(d.attribution.walletAgeDays.subject, "linked");
    assert.equal(d.attribution.walletAgeDays.source, "nansen.first-funder");
    assert.equal(d.attribution.defiTenureDays.lowerBound, true, "a probe proves a floor, not an exact age");
    assert.equal(d.linked?.used, true);
  });

  it("counts a cluster of accounts set up by one funder", () => {
    const d = deriveFacts({ account: account(), linked: linked({ relatedWallets: evidence.ok(12, "nansen.related-wallets") }), observedAt: NOW });
    assert.equal(d.facts.relatedWallets, 12);
    assert.equal(d.infrastructureFunder, false);
  });

  it("ignores the cluster when the funder was an exchange", () => {
    const d = deriveFacts({ account: account(), linked: linked({ relatedWallets: evidence.ok(40, "nansen.related-wallets") }, coinbase), observedAt: NOW });
    assert.equal(d.facts.relatedWallets, 0);
    assert.equal(d.facts.exchangeFunded, true);
  });

  it("treats a funder tied to 60 or more wallets as infrastructure, not a cluster", () => {
    const at59 = deriveFacts({ account: account(), linked: linked({ relatedWallets: evidence.ok(59, "nansen.related-wallets") }), observedAt: NOW });
    const at60 = deriveFacts({ account: account(), linked: linked({ relatedWallets: evidence.ok(60, "nansen.related-wallets") }), observedAt: NOW });
    assert.equal(at59.facts.relatedWallets, 59);
    assert.equal(at60.facts.relatedWallets, 0);
    assert.equal(at60.infrastructureFunder, true);
  });

  it("does not count a linked wallet with a high-risk label, and says why", () => {
    const d = deriveFacts({
      account: account(),
      linked: linked({ riskLabel: evidence.ok<string | null>("Tornado Cash: Router", "nansen.first-funder") }),
      observedAt: NOW,
    });
    assert.equal(d.linked?.used, false);
    assert.equal(d.linked?.excludedFor, "risk-label");
    assert.equal(d.facts.walletAgeDays, 3, "the account is underwritten on its own");
    assert.equal(d.facts.stableBalance, 37_600_000n);
    assert.equal(d.final, true, "a known risk is a known fact, not a missing one");
  });

  it("leaves a linked wallet out, and is not final, when a risk check could not run", () => {
    for (const field of ["liquidations", "relatedWallets", "riskLabel", "funder"] as const) {
      const d = deriveFacts({
        account: account(),
        linked: linked({ [field]: evidence.missing(field === "riskLabel" || field === "funder" ? null : 0, "x.y", "down") }),
        observedAt: NOW,
      });
      assert.equal(d.linked?.used, false, field);
      assert.equal(d.linked?.excludedFor, "missing-risk-check", field);
      assert.equal(d.final, false, field);
      assert.ok(d.missing.includes(`linked.${field}`), field);
      assert.equal(d.facts.priorLiquidations, 0);
    }
  });

  it("never attests a missing positive fact as zero without saying so", () => {
    const d = deriveFacts({ account: account(), linked: linked({ stableBalance: evidence.missing(0, "zerion.positions", "down") }), observedAt: NOW });
    assert.equal(d.final, false);
    assert.deepEqual(d.missing, ["linked.stableBalance"]);
    assert.equal(d.linked?.used, true, "a missing balance hides no risk, so the preview still counts the rest");
  });

  it("with allowPartial, reports conservatively instead", () => {
    const d = deriveFacts({
      account: account(),
      linked: linked({ stableBalance: evidence.missing(0, "zerion.positions"), liquidations: evidence.missing(0, "etherscan.logs") }),
      observedAt: NOW,
      options: { allowPartial: true },
    });
    assert.equal(d.final, true);
    assert.equal(d.linked?.used, false, "a missing risk check still leaves the wallet out");
    assert.equal(d.facts.stableBalance, 37_600_000n);
  });

  it("treats a value that is not a sane integer as missing, never as zero", () => {
    const d = deriveFacts({ account: account({ sentCount: evidence.ok(Number.NaN, "zerion.transactions") }), observedAt: NOW });
    assert.equal(d.final, false);
    assert.deepEqual(d.missing, ["account.sentCount"]);
  });

  it("saturates at the contract's widths instead of wrapping", () => {
    const d = deriveFacts({
      account: account({ sentCount: evidence.ok(Number.MAX_SAFE_INTEGER, "x"), stableBalance: evidence.ok(Number.MAX_SAFE_INTEGER, "x") }),
      linked: linked({
        sentCount: evidence.ok(Number.MAX_SAFE_INTEGER, "x"),
        stableBalance: evidence.ok(Number.MAX_SAFE_INTEGER, "x"),
        liquidations: evidence.ok(1_000_000, "x"),
        firstSeenAt: evidence.ok<number | null>(0, "x"),
      }),
      observedAt: NOW,
    });
    assert.equal(d.facts.txCount, U32_MAX);
    assert.equal(d.facts.priorLiquidations, U16_MAX);
    assert.ok(d.facts.stableBalance <= U64_MAX);
    assert.equal(d.facts.walletAgeDays, Math.floor(NOW / DAY_SECONDS));
  });

  it("reads a first sighting in the future as a new account", () => {
    const d = deriveFacts({ account: account({ firstSeenAt: evidence.ok<number | null>(NOW + 3600, "x") }), observedAt: NOW });
    assert.equal(d.facts.walletAgeDays, 0);
  });

  it("ignores a linked wallet that is the account itself", () => {
    const d = deriveFacts({ account: account(), linked: { ...linked(), address: ACCOUNT }, observedAt: NOW });
    assert.equal(d.linked, null);
  });

  it("refuses an unknown version rather than guessing its rules", () => {
    assert.throws(() => deriveFacts({ account: account(), observedAt: NOW, options: { version: 2 } }), /unknown facts version/);
  });

  it("is deterministic: the same evidence, even after a JSON round trip, gives the same report bytes", () => {
    const input = { user: ACCOUNT, observedAt: NOW, account: account(), linked: linked({}, coinbase), linkVerified: true };
    const again = JSON.parse(JSON.stringify(input));
    const a = underwrite(input);
    const b = underwrite(again);
    assert.equal(a.report, b.report);
    assert.equal(a.report, encodeUnderwritingReport([{ user: ACCOUNT, linkedWallet: input.linked.address, facts: a.facts }]));
  });
});

describe("deriveFacts: evidence a provider without its key could not read", () => {
  it("an unread positive fact is absent: no points, listed, and it does not hold the report back", () => {
    const d = deriveFacts({
      account: seasoned(),
      linked: linked({ stableBalance: evidence.notConfigured(0, "zerion.positions", "zerion and nansen not configured") }),
      observedAt: NOW,
    });
    assert.deepEqual(d.absent, ["linked.stableBalance"]);
    assert.deepEqual(d.missing, []);
    assert.equal(d.final, true);
    assert.equal(d.linked?.used, true);
    assert.equal(d.facts.stableBalance, 37_600_000n, "only the account's own dollars: the linked wallet's are absent, not zero-read");
  });

  it("an unread risk check leaves the linked wallet out and is not final: underwriting runs once, so it waits for the key", () => {
    const nc = <T>(v: T) => evidence.notConfigured(v, "nansen.first-funder", "nansen not configured");
    const d = deriveFacts({
      account: seasoned(),
      linked: linked({ funder: nc<Funder | null>(null), relatedWallets: nc(0), riskLabel: nc<string | null>(null) }),
      observedAt: NOW,
    });
    assert.equal(d.final, false);
    assert.deepEqual(d.missing.sort(), ["linked.funder", "linked.relatedWallets", "linked.riskLabel"]);
    assert.deepEqual(d.absent.sort(), ["linked.funder", "linked.relatedWallets", "linked.riskLabel"]);
    assert.equal(d.linked?.excludedFor, "missing-risk-check");
    assert.equal(d.facts.exchangeFunded, false);

    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: seasoned(), linked: linked({ funder: nc<Funder | null>(null), relatedWallets: nc(0), riskLabel: nc<string | null>(null) }), linkVerified: true });
    assert.equal(out.unavailable, true);
    assert.equal(out.report, null);
    assert.match(out.decision.headline, /Credit reviews aren't fully set up here yet\.$/);
    assert.equal(out.decision.nextSteps.some((s) => s.id === "retry"), false, "waiting won't help");
  });

  it("a risk check no configured provider can run decides it, whatever else failed: retrying can't finish it", () => {
    const out = underwrite({
      user: ACCOUNT,
      observedAt: NOW,
      account: seasoned(),
      linked: linked({ liquidations: evidence.missing(0, "etherscan.logs", "etherscan unavailable"), riskLabel: evidence.notConfigured<string | null>(null, "nansen.labels", "nansen not configured") }),
      linkVerified: true,
    });
    assert.equal(out.final, false);
    assert.equal(out.unavailable, true);
    assert.equal(out.decision.nextSteps.some((s) => s.id === "retry"), false);
  });

  it("a real failure with nothing unconfigured still asks to retry", () => {
    const out = underwrite({
      user: ACCOUNT,
      observedAt: NOW,
      account: seasoned(),
      linked: linked({ liquidations: evidence.missing(0, "etherscan.logs", "etherscan unavailable") }),
      linkVerified: true,
    });
    assert.equal(out.final, false);
    assert.equal(out.unavailable, false);
    assert.ok(out.decision.nextSteps.some((s) => s.id === "retry"));
  });

  it("a thin file whose history was unread is not called thin: no promise about when Pay in 4 opens", () => {
    const out = underwrite({
      user: ACCOUNT,
      observedAt: NOW,
      account: account({
        firstSeenAt: evidence.notConfigured<number | null>(null, "etherscan.tokentx", "zerion and etherscan not configured"),
        sentCount: evidence.notConfigured(0, "etherscan.tokentx", "zerion and etherscan not configured"),
      }),
    });
    assert.equal(out.final, true);
    assert.equal(out.attest, false);
    assert.equal(out.unavailable, true);
    assert.equal(out.decision.headline, "Credit reviews aren't fully set up here yet.");
    assert.equal(out.decision.nextSteps.some((s) => s.id === "build-history"), false);
  });

  it("a thin file with every source read stays a thin file", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: account() });
    assert.equal(out.unavailable, false);
    assert.deepEqual(out.absent, []);
    assert.equal(out.decision.headline, "Pay in 4 opens once there's a little more history here.");
  });
});

describe("underwrite: what may be reported", () => {
  it("never reports a linked wallet whose ownership was not proven, not even with allowPartial", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: account(), linked: linked(), options: { allowPartial: true } });
    assert.equal(out.final, false);
    assert.ok(out.missing.includes("linked.ownership"));
    assert.equal(out.report, null);
  });

  it("asks the buyer to confirm, rather than to wait, when only the signature is missing", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: account(), linked: linked({}, coinbase) });
    assert.deepEqual(out.missing, ["linked.ownership"]);
    assert.match(out.decision.headline, /^Confirm with your wallet to open a \$\d/);
    assert.equal(out.decision.nextSteps[0]?.id, "link-history");
    assert.ok(!out.decision.nextSteps.some((s) => s.id === "retry"));
  });

  it("reports a proven linked wallet, in the receiver's format, naming the wallet", () => {
    const l = linked();
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: account(), linked: l, linkVerified: true });
    assert.equal(out.final, true);
    assert.match(out.report ?? "", /^0x[0-9a-f]{832}$/);
    assert.equal(out.linkedWallet, l.address);
    const r = decodeUnderwritingReport(out.report!);
    assert.deepEqual(r.items, [{ user: ACCOUNT.toLowerCase(), linkedWallet: l.address.toLowerCase(), facts: out.facts }]);
  });

  it("an account scored alone reports a zero linked wallet, and so does a 'linked' wallet that is the account", () => {
    const alone = underwrite({ user: ACCOUNT, observedAt: NOW, account: seasoned(), linkVerified: true });
    assert.equal(alone.linkedWallet, null);
    assert.equal(decodeUnderwritingReport(alone.report!).items[0]!.linkedWallet, null);

    const self = underwrite({ user: ACCOUNT, observedAt: NOW, account: seasoned(), linked: { ...linked(), address: ACCOUNT } });
    assert.equal(self.final, true, "linking the account to itself needs no proof");
    assert.equal(self.linkedWallet, null);
    assert.equal(decodeUnderwritingReport(self.report!).items[0]!.linkedWallet, null);
  });

  it("names a linked wallet it left out for a risk label too, so the receiver still holds it to this account", () => {
    const l = linked({ riskLabel: evidence.ok<string | null>("Sanctioned: OFAC", "nansen.first-funder") });
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: seasoned(), linked: l, linkVerified: true });
    assert.equal(out.derivation.linked?.used, false);
    assert.equal(decodeUnderwritingReport(out.report!).items[0]!.linkedWallet, l.address.toLowerCase());

    // Left out, the wallet brings no history: a three-day-old account alone is too thin to attest.
    const thin = underwrite({ user: ACCOUNT, observedAt: NOW, account: account(), linked: l, linkVerified: true });
    assert.equal(thin.final, true);
    assert.equal(thin.report, null);
  });

  it("stamps the facts with the caller's clock, never its own", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: 1_700_000_000, account: account(), linkVerified: true });
    assert.equal(out.facts.observedAt, 1_700_000_000n);
  });

  it("keeps the preview when not final, so the app can show a floor", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: seasoned({ stableBalance: evidence.missing(0, "rpc.balance") }) });
    assert.equal(out.final, false);
    assert.equal(out.report, null);
    assert.equal(out.decision.limit, 200_000_000n);
    assert.equal(out.decision.headline, "Your line is $200 for now. We're finishing a check on your history.");
    assert.equal(out.decision.nextSteps[0]?.id, "retry");
  });

  it("a thin preview that is not final promises no line: it only says a check is running", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: account({ stableBalance: evidence.missing(0, "rpc.balance") }) });
    assert.equal(out.final, false);
    assert.equal(out.attest, false);
    assert.equal(out.decision.limit, 0n);
    assert.equal(out.decision.headline, "We're finishing a check on your history.");
    assert.deepEqual(out.decision.nextSteps.map((s) => s.id), ["retry", "link-history", "secure"]);
  });
});


describe("the thin-file gate: a report for an empty account is a free $200 line, so thin files are not attested", () => {
  const empty = (): SubjectEvidence =>
    account({
      firstSeenAt: evidence.empty<number | null>(null, "zerion.transactions"),
      sentCount: evidence.ok(0, "zerion.transactions"),
      stableBalance: evidence.ok(0, "rpc.balance"),
    });
  const at = (age: number, sent: number, o: Partial<SubjectEvidence> = {}) =>
    underwrite({
      user: ACCOUNT,
      observedAt: NOW,
      account: account({
        firstSeenAt: evidence.ok<number | null>(days(age), "zerion.transactions"),
        sentCount: evidence.ok(sent, "zerion.transactions"),
        ...o,
      }),
    });

  it("the review's proof: an account with no history at all is final, but nothing is reported and no line opens", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: empty(), linkVerified: true });
    assert.deepEqual(
      { walletAgeDays: out.facts.walletAgeDays, txCount: out.facts.txCount, stableBalance: out.facts.stableBalance },
      { walletAgeDays: 0, txCount: 0, stableBalance: 0n },
    );
    assert.equal(out.breakdown.score, 520, "ScoreManager would open this at the $200 floor");
    assert.equal(out.final, true, "nothing is missing: this is the answer, not a retry");
    assert.equal(out.attest, false);
    assert.equal(out.report, null);
    assert.equal(out.decision.limit, 0n);
    assert.equal(out.decision.available, 0n);
    assert.equal(out.decision.payIn4.allowed, false);
    assert.equal(out.decision.payIn4.maxPurchase, 0n);
    assert.deepEqual(out.decision.thinFile, [
      { fact: "walletAgeDays", have: 0, need: 90 },
      { fact: "txCount", have: 0, need: 10 },
    ]);
    assert.equal(out.decision.payIn4.reason, "Pay in 4 opens after 90 days of history and 10 payments and transfers.");
    assert.equal(out.decision.headline, "Pay in 4 opens once there's a little more history here.");
    assert.equal(out.decision.nextTier, null, "no line, so repaying has nothing to raise");
    assert.deepEqual(
      out.decision.nextSteps.map((s) => [s.id, s.label]),
      [
        ["link-history", "Open a line now: confirm with the wallet you already use."],
        ["build-history", "Keep using Polaris: Pay in 4 opens in 90 days, once you've made 10 more payments and transfers."],
        ["secure", "Set money aside to pay in 4 against it."],
      ],
    );
  });

  it("the three-day-old account is told exactly what is left", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: account(), linkVerified: true, purchase: 200_000_000n });
    assert.equal(out.attest, false);
    assert.equal(out.report, null);
    assert.equal(
      out.decision.nextSteps.find((s) => s.id === "build-history")?.label,
      "Keep using Polaris: Pay in 4 opens in 87 days, once you've made 8 more payments and transfers.",
    );
    // Secured-only, as ScoreManager treats a wallet not yet underwritten: collateral at face value.
    assert.equal(out.decision.nextSteps.find((s) => s.id === "secure")?.label, "Set aside $201.54 to pay in 4 for this purchase.");
  });

  it("ScoreManager.isThinFile's rule, exactly: 90 days AND 10 transactions clear it, and nothing less does", () => {
    for (const cleared of [at(90, 10), at(400, 12), at(90, 300)]) {
      assert.equal(cleared.attest, true);
      assert.match(cleared.report ?? "", /^0x[0-9a-f]{832}$/);
      assert.equal(cleared.decision.thinFile, null);
      assert.ok(cleared.decision.limit >= 200_000_000n);
    }
    // One point from time or identity used to be enough; the chain refuses these with ThinFile.
    for (const refused of [at(30, 0), at(0, 25), at(89, 500), at(400, 9), at(3, 2, { defiSince: evidence.ok<number | null>(days(30), "zerion.probe") })]) {
      assert.equal(refused.attest, false);
      assert.equal(refused.report, null);
    }
    const exchange = underwrite({
      user: ACCOUNT,
      observedAt: NOW,
      account: empty(),
      linked: linked({ firstSeenAt: evidence.ok<number | null>(days(2), "nansen.first-funder"), sentCount: evidence.ok(1, "rpc.nonce"), defiSince: evidence.empty<number | null>(null, "zerion.probe") }, { ...coinbase, fundedAt: days(2) }),
      linkVerified: true,
    });
    assert.equal(exchange.facts.exchangeFunded, true);
    assert.equal(exchange.attest, false, "exchange funding two days ago is not a history the chain accepts");
  });

  it("one short is thin, and dollars do not count: a balance can be walked through account after account", () => {
    const rich = at(89, 9, { stableBalance: evidence.ok(5_000_000_000, "rpc.balance") });
    assert.equal(rich.breakdown.balance, 50);
    assert.equal(rich.final, true);
    assert.equal(rich.report, null);
    assert.equal(rich.decision.limit, 0n);
    assert.deepEqual(rich.decision.thinFile, [
      { fact: "walletAgeDays", have: 89, need: 90 },
      { fact: "txCount", have: 9, need: 10 },
    ]);
    assert.equal(
      rich.decision.nextSteps.find((s) => s.id === "build-history")?.label,
      "Keep using Polaris: Pay in 4 opens in 1 day, once you've made 1 more payment or transfer.",
    );
    const oldEnough = at(120, 4);
    assert.deepEqual(oldEnough.decision.thinFile, [{ fact: "txCount", have: 4, need: 10 }]);
    assert.equal(oldEnough.decision.nextSteps.find((s) => s.id === "build-history")?.label, "Keep using Polaris: Pay in 4 opens after 6 more payments and transfers.");
  });

  it("a proven history clears it at once, even for a brand-new account", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: empty(), linked: linked({}, coinbase), linkVerified: true });
    assert.equal(out.attest, true);
    assert.ok(out.report);
    assert.equal(out.decision.thinFile, null);
    assert.equal(out.decision.limit, 1_000_000_000n);
  });

  it("a throwaway wallet does not clear it: a fresh linked wallet with no history is thin too, proof or not", () => {
    const throwaway = linked(
      {
        firstSeenAt: evidence.ok<number | null>(days(2), "nansen.first-funder"),
        sentCount: evidence.ok(1, "rpc.nonce"),
        defiSince: evidence.empty<number | null>(null, "zerion.probe"),
      },
      { ...peer, fundedAt: days(2) },
    );
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: empty(), linked: throwaway, linkVerified: true });
    assert.equal(out.derivation.linked?.used, true);
    assert.equal(out.final, true);
    assert.equal(out.report, null);
    assert.equal(out.decision.limit, 0n);

    // Before the signature, the preview must not promise a line that confirming would open.
    const unproven = underwrite({ user: ACCOUNT, observedAt: NOW, account: empty(), linked: throwaway });
    assert.deepEqual(unproven.missing, ["linked.ownership"]);
    assert.equal(unproven.decision.headline, "Pay in 4 opens once there's a little more history here.");
    assert.ok(!unproven.decision.nextSteps.some((s) => s.id === "link-history"), "confirming this wallet would not help");
  });

  it("a thin file that declines is attested: the decline sticks, and the wallet can never back another account", () => {
    const risky = linked(
      {
        firstSeenAt: evidence.ok<number | null>(days(5), "nansen.first-funder"),
        sentCount: evidence.ok(1, "rpc.nonce"),
        defiSince: evidence.empty<number | null>(null, "zerion.probe"),
        relatedWallets: evidence.ok(40, "nansen.related-wallets"),
      },
      { ...peer, fundedAt: days(5) },
    );
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: empty(), linked: risky, linkVerified: true });
    assert.equal(out.breakdown.declined, true);
    assert.equal(out.attest, true);
    assert.equal(decodeUnderwritingReport(out.report!).items[0]!.linkedWallet, WALLET.toLowerCase());
    assert.equal(out.decision.thinFile, null);
    assert.equal(out.decision.headline, "We can't offer you credit right now.");
    assert.ok(!out.decision.nextSteps.some((s) => s.id === "build-history" || s.id === "link-history"));
  });

  it("collateral still works on a thin file, at face value", () => {
    const out = underwrite({ user: ACCOUNT, observedAt: NOW, account: account(), linkVerified: true });
    const d = decide({ score: out.breakdown.score, declined: false, thinFile: out.decision.thinFile, collateralBoost: 300_000_000n, purchase: 200_000_000n });
    assert.equal(d.limit, 0n);
    assert.equal(d.available, 300_000_000n);
    assert.equal(d.payIn4.allowed, true);
    assert.match(d.headline, /^You can pay in 4 for up to \$29\d\.\d\d\.$/);
  });

  it("facts already attested are explained as the chain scored them: the gate does not apply after the fact", () => {
    const { decision } = explainOnChainFacts({
      walletAgeDays: 0,
      txCount: 0,
      stableBalance: 0n,
      defiTenureDays: 0,
      priorLiquidations: 0,
      relatedWallets: 0,
      exchangeFunded: false,
      observedAt: BigInt(NOW),
    });
    assert.equal(decision.thinFile, null);
    assert.equal(decision.limit, 200_000_000n);
  });

  it("is the CRE workflow's gate and ScoreManager.isThinFile, point for point, over a seeded sweep", () => {
    // workflows/src/underwriting/thin.ts and ScoreManager.isThinFile, restated: attest when declined,
    // or when the facts show at least 90 days AND 10 transactions of history.
    const chainAttests = (f: Parameters<typeof isAttestable>[0]) =>
      scoreBreakdown(f).declined || (f.walletAgeDays >= 90 && f.txCount >= 10);
    let seed = 0x7a1c;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32);
    const pick = (max: number) => Math.floor(rand() * (max + 1));
    let thin = 0;
    let attested = 0;
    for (let i = 0; i < 2_000; i++) {
      const f = {
        walletAgeDays: pick(140),
        txCount: pick(20),
        stableBalance: BigInt(pick(900)) * 1_000_000n,
        defiTenureDays: pick(35),
        priorLiquidations: rand() < 0.05 ? 2 : 0,
        relatedWallets: rand() < 0.05 ? 30 : pick(5),
        exchangeFunded: rand() < 0.1,
      };
      assert.equal(isAttestable(f), chainAttests(f), JSON.stringify({ ...f, stableBalance: String(f.stableBalance) }));
      assert.equal(attestGaps(f).length === 0, chainAttests(f));
      if (chainAttests(f)) attested += 1;
      else thin += 1;
    }
    assert.ok(thin > 100 && attested > 100, "the sweep reaches both sides of the gate");
    // ScoreManager.MIN_HISTORY_DAYS and MIN_HISTORY_TXS.
    assert.deepEqual(ATTEST_MINIMUM, { walletAgeDays: 90, txCount: 10 });
  });
});
