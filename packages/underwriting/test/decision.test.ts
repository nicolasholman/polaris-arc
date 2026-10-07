import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOAN } from "../src/core/constants.ts";
import { collateralFor, decide, maxPrincipal, planInterest, quotePlan } from "../src/core/decision.ts";

const $ = (n: number) => BigInt(Math.round(n * 1e6));

describe("Pay in 4 pricing, as PolarisLoanEngine computes it", () => {
  it("$200 over four weeks is 4 × $50.38, $1.53 of interest (plan §2)", () => {
    const q = quotePlan($(200));
    assert.equal(q.interest, 1_534_246n);
    assert.equal(q.total, 201_534_246n);
    assert.deepEqual(q.amounts, [50_383_562n, 50_383_561n, 50_383_562n, 50_383_561n]);
    assert.equal(q.amounts.reduce((a, b) => a + b, 0n), q.total);
    assert.equal(q.installments, 4);
    assert.equal(q.intervalSeconds, 7 * 86_400);
  });

  it("the instalments always add up to the total, for any size and count", () => {
    for (const principal of [1n, 7n, $(0.03), $(19.99), $(333.33), $(998.76)]) {
      for (const n of [1, 2, 3, 4, 6, 12, 24]) {
        const q = quotePlan(principal, n, 14 * 86_400);
        assert.equal(q.amounts.reduce((a, b) => a + b, 0n), q.total, `${principal} in ${n}`);
        assert.ok(q.amounts.every((a) => a >= 0n));
      }
    }
  });

  it("refuses what createLoan refuses", () => {
    assert.throws(() => quotePlan($(100), 0), RangeError);
    assert.throws(() => quotePlan($(100), 25), RangeError);
  });

  it("finds the largest purchase that fits, to the unit", () => {
    for (const available of [$(200), $(500), $(1000), $(1), 3n]) {
      const p = maxPrincipal(available);
      assert.ok(p + planInterest(p, 4, LOAN.PAY_IN_4_INTERVAL) <= available);
      assert.ok(p + 1n + planInterest(p + 1n, 4, LOAN.PAY_IN_4_INTERVAL) > available);
    }
    assert.equal(maxPrincipal(0n), 0n);
    assert.equal(maxPrincipal(-5n), 0n);
  });

  it("rounds the collateral needed up to the cent, and it covers the shortfall", () => {
    const lock = collateralFor(1_534_246n, 15_000);
    assert.equal(lock, 1_030_000n);
    assert.ok((lock * 15_000n) / 10_000n >= 1_534_246n);
    assert.equal(collateralFor(0n, 15_000), 0n);
  });
});

describe("the decision", () => {
  it("cold start: at the $200 floor a $200 purchase does not fit, and the decision says what would", () => {
    const d = decide({ score: 520, declined: false, purchase: $(200) });
    assert.equal(d.limit, $(200));
    assert.equal(d.payIn4.allowed, false);
    assert.equal(d.payIn4.quote?.fits, false);
    assert.match(d.payIn4.reason ?? "", /\$1\.53 more than you can pay in 4 today/);
    assert.match(d.payIn4.reason ?? "", /up to \$198\.47/);
    const secure = d.nextSteps.find((s) => s.id === "secure");
    assert.match(secure?.label ?? "", /Set aside \$1\.03/);
    assert.ok(d.nextSteps.some((s) => s.id === "link-history"));
    assert.ok(d.nextSteps.some((s) => s.id === "repay" && /5 weeks to reach a \$500 line/.test(s.label)));
  });

  it("a $150 purchase at the floor fits", () => {
    const d = decide({ score: 520, declined: false, purchase: $(150) });
    assert.equal(d.payIn4.allowed, true);
    assert.equal(d.payIn4.reason, null);
    assert.match(d.headline, /pay in 4 for up to \$198\.47/);
  });

  it("open plans reduce what is available", () => {
    const d = decide({ score: 692, declined: false, activeDebt: $(900) });
    assert.equal(d.limit, $(1000));
    assert.equal(d.available, $(100));
    assert.ok(d.payIn4.maxPurchase < $(100));
  });

  it("a fully used line offers nothing and says why", () => {
    const d = decide({ score: 600, declined: false, activeDebt: $(500) });
    assert.equal(d.payIn4.allowed, false);
    assert.match(d.payIn4.reason ?? "", /in use/);
  });

  it("declined: no unsecured line, the secured path at face value", () => {
    const d = decide({ score: 465, declined: true, declineReason: "Two or more past loans elsewhere were closed by the lender.", purchase: $(200) });
    assert.equal(d.limit, 0n);
    assert.equal(d.payIn4.allowed, false);
    assert.equal(d.declineReason, "Two or more past loans elsewhere were closed by the lender.");
    assert.equal(d.headline, "We can't offer you credit right now.");
    assert.equal(d.nextTier, null, "a declined line is not reached by repaying");
    const secure = d.nextSteps.find((s) => s.id === "secure");
    assert.match(secure?.label ?? "", /\$201\.54/, "face value: the whole plan");
    assert.ok(!d.nextSteps.some((s) => s.id === "link-history"));
  });

  it("collateral already locked lifts what is available", () => {
    const d = decide({ score: 520, declined: false, collateralBoost: $(150), purchase: $(300) });
    assert.equal(d.available, $(350));
    assert.equal(d.payIn4.allowed, true);
  });
});
