import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide } from "../src/core/decision.ts";
import { explainFacts, merchantVoice, poweredBy, PROVIDER_NAMES } from "../src/core/reasons.ts";
import { scoreBreakdown } from "../src/core/score.ts";
import type { CreditDecision, Facts } from "../src/core/types.ts";
import { explainOnChainFacts } from "../src/core/underwrite.ts";
import { JARGON } from "./helpers.ts";

const f = (o: Partial<Facts> = {}): Facts => ({
  walletAgeDays: 0,
  txCount: 0,
  stableBalance: 0n,
  defiTenureDays: 0,
  priorLiquidations: 0,
  relatedWallets: 0,
  exchangeFunded: false,
  observedAt: 0n,
  ...o,
});

/** Every string the buyer can see, except the one step the plan lets say "wallet". */
function visible(d: CreditDecision): string[] {
  return [
    d.headline,
    d.declineReason ?? "",
    d.payIn4.reason ?? "",
    ...d.reasons.flatMap((r) => [r.label, r.text]),
    ...d.nextSteps.filter((s) => s.id !== "link-history").map((s) => s.label),
  ].filter(Boolean);
}

describe("reasons in the buyer's words", () => {
  it('says "You\'ve used this account for 2 years · +48"', () => {
    const facts = f({ walletAgeDays: 730 });
    const lines = explainFacts(facts, scoreBreakdown(facts), {
      attribution: { walletAgeDays: { subject: "account", source: "zerion.transactions", status: "ok", lowerBound: false } } as never,
    });
    assert.equal(lines.find((l) => l.id === "age")?.text, "You've used this account for 2 years · +48");
  });

  it("credits a linked wallet's age to Nansen, and says over when a probe only proved a floor", () => {
    const facts = f({ walletAgeDays: 365 });
    const ctx = { linked: { address: "0x", used: true, excludedFor: null, riskLabel: null } };
    const exact = explainFacts(facts, scoreBreakdown(facts), {
      ...ctx,
      attribution: { walletAgeDays: { subject: "linked", source: "nansen.first-funder", status: "ok", lowerBound: false } } as never,
    });
    const probed = explainFacts(facts, scoreBreakdown(facts), {
      ...ctx,
      attribution: { walletAgeDays: { subject: "linked", source: "zerion.probe", status: "fallback", lowerBound: true } } as never,
    });
    assert.equal(exact[0]?.text, "You've used your linked account for a year · +24");
    assert.equal(exact[0]?.provider, "nansen");
    assert.equal(probed[0]?.text, "You've used your linked account for over a year · +24");
    assert.equal(probed[0]?.provider, "zerion");
  });

  it("explains on-chain facts with a linked account as that account's age and balances across both", () => {
    const facts = f({ walletAgeDays: 1100, txCount: 40, stableBalance: 4_851_000_000n, exchangeFunded: true });
    const labels = explainOnChainFacts(facts, { hasLinked: true }).decision.reasons.map((r) => r.label);
    assert.ok(labels.includes("You've used your linked account for 3 years"), labels.join(" | "));
    assert.ok(labels.includes("You keep $4,851 on hand across your accounts"), labels.join(" | "));
    const alone = explainOnChainFacts(facts).decision.reasons.map((r) => r.label);
    assert.ok(alone.includes("You've used this account for 3 years"), alone.join(" | "));
  });

  it("has a merchant's voice for every line that speaks to the buyer", () => {
    assert.equal(merchantVoice("You've used your linked account for 3 years"), "Buyer's linked account in use for 3 years");
    assert.equal(merchantVoice("You've used this account for over a year"), "Buyer's account in use for over a year");
    assert.equal(merchantVoice("You keep $4,851 on hand across your accounts"), "Buyer keeps $4,851 across their accounts");
    assert.equal(merchantVoice("You keep $900 on hand"), "Buyer keeps $900 on hand");
    assert.equal(merchantVoice("Less than $100 on hand"), "Buyer keeps less than $100 on hand");
    assert.equal(merchantVoice("You've made 40 payments and transfers"), "Buyer made 40 payments and transfers");
    assert.equal(merchantVoice("First topped up from a major exchange"), "First topped up from a major exchange");
    // Across a sweep, no merchant line still talks to "you".
    for (let years = 0; years < 6; years++) {
      const facts = f({ walletAgeDays: 40 + years * 365, txCount: years * 20, stableBalance: BigInt(years) * 700_000_000n, defiTenureDays: years * 200, exchangeFunded: years % 2 === 0, relatedWallets: years });
      for (const linked of [true, false]) {
        for (const r of explainOnChainFacts(facts, { hasLinked: linked }).decision.reasons) {
          assert.doesNotMatch(merchantVoice(r.label), /\b(you|your|you've)\b/i, r.label);
        }
      }
    }
  });

  it("names the exchange and the points it earned", () => {
    const facts = f({ exchangeFunded: true });
    const lines = explainFacts(facts, scoreBreakdown(facts), { exchange: "Coinbase" });
    const line = lines.find((l) => l.id === "exchange");
    assert.equal(line?.text, "First topped up from Coinbase, a major exchange · +10");
    assert.equal(line?.provider, "nansen");
  });

  it("explains penalties plainly", () => {
    const facts = f({ priorLiquidations: 1, relatedWallets: 9 });
    const lines = explainFacts(facts, scoreBreakdown(facts), {});
    assert.equal(lines.find((l) => l.id === "liquidations")?.text, "A past loan elsewhere was closed by the lender · −75");
    assert.equal(lines.find((l) => l.id === "cluster")?.text, "Set up from the same source as 9 other accounts · −12");
  });

  it("the lines add up to the score, from the 520 floor", () => {
    const rand = (() => {
      let s = 7;
      return () => ((s = (s * 48271) % 2147483647) / 2147483647);
    })();
    for (let i = 0; i < 500; i++) {
      const facts = f({
        walletAgeDays: Math.floor(rand() * 1500),
        txCount: Math.floor(rand() * 2000),
        stableBalance: BigInt(Math.floor(rand() * 8_000)) * 1_000_000n,
        defiTenureDays: Math.floor(rand() * 1200),
        priorLiquidations: rand() < 0.1 ? 1 : 0,
        relatedWallets: Math.floor(rand() * 20),
        exchangeFunded: rand() < 0.4,
      });
      const b = scoreBreakdown(facts);
      const sum = explainFacts(facts, b, { linked: { address: "0x", used: true, excludedFor: null, riskLabel: null } }).reduce((a, l) => a + l.points, 0);
      assert.equal(b.floor + sum, b.raw);
    }
  });

  it("orders what helped first, then what cost, then the rest", () => {
    const facts = f({ walletAgeDays: 400, stableBalance: 900_000_000n, priorLiquidations: 1 });
    const kinds = explainFacts(facts, scoreBreakdown(facts), {}).map((l) => l.kind);
    const order = { plus: 0, minus: 1, neutral: 2, info: 3 } as const;
    assert.deepEqual(kinds, [...kinds].sort((a, b) => order[a] - order[b]));
  });

  it("never uses a word from the plan's 'Words the buyer never sees' table", () => {
    const cases: Array<Partial<Facts>> = [
      {},
      { walletAgeDays: 1210, txCount: 902, stableBalance: 4_237_850_000n, defiTenureDays: 730, exchangeFunded: true },
      { priorLiquidations: 2, walletAgeDays: 800 },
      { relatedWallets: 30 },
      { relatedWallets: 8, stableBalance: 50_000_000n },
    ];
    for (const c of cases) {
      for (const purchase of [null, 200_000_000n, 5_000_000_000n]) {
        const { decision } = explainOnChainFacts(f(c), { purchase });
        for (const text of visible(decision)) assert.doesNotMatch(text, JARGON, text);
        const linkedCopy = decide({ score: 520, declined: false, hasLinked: false }).nextSteps.find((s) => s.id === "link-history");
        assert.equal(linkedCopy?.label, "Raise your limit: confirm with the wallet you already use.", "the plan's one allowed exception");
      }
    }
  });

  it("what a missing key leaves out is said in the buyer's words too, and in the merchant's", () => {
    const facts = f({ walletAgeDays: 120, txCount: 12 });
    const lines = explainFacts(facts, scoreBreakdown(facts), {
      linked: { address: "0xb0b0000000000000000000000000000000000001", used: false, excludedFor: "missing-risk-check", riskLabel: null },
      missing: ["linked.funder"],
      absent: ["linked.funder", "account.firstSeenAt"],
    });
    const texts = lines.map((l) => l.text);
    assert.ok(texts.includes("We can't check your linked account here yet, so it doesn't count"), texts.join(" | "));
    assert.ok(texts.includes("Some of this account's history can't be read here yet, so it doesn't count"), texts.join(" | "));
    for (const t of texts) assert.doesNotMatch(t, JARGON, t);
    assert.equal(merchantVoice("We can't check your linked account here yet, so it doesn't count"), "We can't check the buyer's linked account here yet, so it doesn't count");
  });

  it("credits the data providers a decision stands on, for a 'from Nansen' badge, never Polaris's own rules", () => {
    const facts = f({ walletAgeDays: 1210, txCount: 902, exchangeFunded: true, relatedWallets: 8 });
    const lines = explainFacts(facts, scoreBreakdown(facts), {
      attribution: {
        walletAgeDays: { subject: "linked", source: "nansen.first-funder", status: "ok", lowerBound: false },
        txCount: { subject: "linked", source: "rpc.nonce", status: "ok", lowerBound: false },
        stableBalance: { subject: "account", source: "zerion.positions", status: "ok", lowerBound: false },
        defiTenureDays: { subject: "none", source: "polaris.rule", status: "ok", lowerBound: false },
        priorLiquidations: { subject: "linked", source: "etherscan.logs", status: "ok", lowerBound: false },
        relatedWallets: { subject: "linked", source: "nansen.related-wallets", status: "ok", lowerBound: false },
        exchangeFunded: { subject: "linked", source: "nansen.first-funder", status: "ok", lowerBound: false },
      },
      linked: { address: "0xb0b0000000000000000000000000000000000001", used: true, excludedFor: null, riskLabel: null },
    });
    const credits = poweredBy(lines);
    assert.deepEqual(
      credits.map((c) => c.name),
      ["Nansen", "Zerion", "Etherscan"],
    );
    assert.deepEqual(credits[0]?.reasons.sort(), ["age", "cluster", "exchange"]);
    assert.equal(poweredBy([{ id: "age", provider: "polaris" }, { id: "activity", provider: "rpc" }]).length, 0);
    assert.equal(PROVIDER_NAMES.nansen, "Nansen");
  });

  it("a thin file's copy keeps to the same words, for every gap and every pending state", () => {
    const gaps = (age: number, sent: number) => [
      { fact: "walletAgeDays" as const, have: age, need: 90 },
      { fact: "txCount" as const, have: sent, need: 10 },
    ];
    const gapSets = [gaps(0, 0), gaps(89, 9), gaps(3, 2), [gaps(1, 1)[0]!], [gaps(1, 1)[1]!]];
    for (const thinFile of gapSets) {
      for (const pending of [null, "checks", "ownership", "unavailable"] as const) {
        for (const purchase of [null, 200_000_000n]) {
          for (const collateralBoost of [0n, 300_000_000n]) {
            const d = decide({ score: 520, declined: false, thinFile, pending, purchase, collateralBoost, hasLinked: pending === "ownership" });
            for (const text of visible(d)) assert.doesNotMatch(text, JARGON, text);
            assert.equal(d.limit, 0n);
          }
        }
      }
    }
    const step = decide({ score: 520, declined: false, thinFile: gapSets[0] }).nextSteps.find((s) => s.id === "link-history");
    assert.equal(step?.label, "Open a line now: confirm with the wallet you already use.", "the Bring your history step, the one place 'wallet' is allowed");
  });
});
