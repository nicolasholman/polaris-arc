import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, keccak256 } from "viem";

import { equalShares, memoHash, memoMatches, parseSplitFragment, planSplit, shareLabel, type SplitMemo, splitPrefill, splitUrl } from "../src/lib/split.ts";

/**
 * Split-the-bill links in the app: the shares a form makes, the link's
 * words and the hash the organiser signs over them. The contracts' suite
 * (packages/contracts test/metropolis/PolarisSplit.test.js) hashes the words
 * the same way.
 */

const USD = (n: number) => BigInt(Math.round(n * 1e6));
const ID = "0x5f1e0d6c7b8a99887766554433221100ffeeddccbbaa99887766554433221100" as const;
const dinner: SplitMemo = { description: "Dinner at Lucia", organiserName: "Maya", billTotal: USD(120), labels: ["Sam", "Priya", "Jon"] };

describe("equal shares", () => {
  it("add up to the bill to the micro-dollar, the first shares carrying the remainder", () => {
    assert.deepEqual(equalShares(USD(90), 3), [USD(30), USD(30), USD(30)]);
    const thirds = equalShares(USD(100), 3);
    assert.deepEqual(thirds, [33_333_334n, 33_333_333n, 33_333_333n]);
    assert.equal(thirds.reduce((a, b) => a + b, 0n), USD(100));
    assert.throws(() => equalShares(USD(10), 0), RangeError);
  });
});

describe("the create form's plan", () => {
  const base = { bill: USD(120), mode: "equal" as const, people: 4, includeMe: true, names: ["Sam", "", "Jon"], rows: [] };

  it("equally, with you in: friends are asked for their shares, yours stays yours", () => {
    const plan = planSplit(base);
    assert.ok(plan.ok);
    assert.deepEqual(plan.amounts, [USD(30), USD(30), USD(30)]);
    assert.deepEqual(plan.labels, ["Sam", "", "Jon"]);
    assert.equal(plan.collect, USD(90));
    assert.equal(plan.yourPart, USD(30));
    assert.equal(plan.each, USD(30));
  });

  it("equally, without you: everyone in the count owes a share", () => {
    const plan = planSplit({ ...base, includeMe: false, people: 3, names: [] });
    assert.ok(plan.ok);
    assert.equal(plan.amounts.length, 3);
    assert.equal(plan.collect, USD(120));
    assert.equal(plan.yourPart, 0n);
  });

  it("by amount: named shares, and what's left of the bill is yours", () => {
    const plan = planSplit({ ...base, mode: "custom", rows: [{ name: "Sam", amount: "45" }, { name: "Priya", amount: "30.5" }, { name: "", amount: "" }] });
    assert.ok(plan.ok);
    assert.deepEqual(plan.amounts, [USD(45), USD(30.5)]);
    assert.deepEqual(plan.labels, ["Sam", "Priya"]);
    assert.equal(plan.yourPart, USD(44.5));
  });

  it("says why it can't be made yet: no bill, a nameless share, too much, a dust share", () => {
    assert.deepEqual(planSplit({ ...base, bill: 0n }), { ok: false, reason: null });
    assert.match(String((planSplit({ ...base, mode: "custom", rows: [{ name: "", amount: "5" }] }) as { reason: string }).reason), /name/);
    assert.match(String((planSplit({ ...base, mode: "custom", rows: [{ name: "Sam", amount: "200" }] }) as { reason: string }).reason), /\$80\.00 more than the bill/);
    assert.match(String((planSplit({ ...base, bill: USD(0.2), people: 4 }) as { reason: string }).reason), /at least \$0\.10/);
    assert.match(String((planSplit({ ...base, people: 1 }) as { reason: string }).reason), /two people/);
  });
});

describe("the link's words", () => {
  it("hash as abi.encode(string, string, uint256, string[]), what the organiser signs", () => {
    const expected = keccak256(
      encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "string[]" }], ["Dinner at Lucia", "Maya", USD(120), ["Sam", "Priya", "Jon"]]),
    );
    assert.equal(memoHash(dinner), expected);
  });

  it("travel in the fragment and come back exactly, so they still match what was signed", () => {
    const url = splitUrl("https://app.polarispay.app", ID, dinner);
    assert.ok(url.startsWith(`https://app.polarispay.app/split/${ID}#`));
    const parsed = parseSplitFragment(new URL(url).hash);
    assert.deepEqual(parsed, dinner);
    assert.ok(memoMatches(parsed, memoHash(dinner)));
  });

  it("keep unnamed shares, so the hash still matches", () => {
    const memo: SplitMemo = { description: "", organiserName: "Maya", billTotal: USD(60), labels: ["", "", ""] };
    const parsed = parseSplitFragment(new URL(splitUrl("https://x.test", ID, memo)).hash);
    assert.deepEqual(parsed, memo);
    assert.equal(shareLabel(parsed, 1), "Share 2");
    assert.equal(shareLabel(dinner, 1), "Priya");
  });

  it("changed on the way, don't match: the page then hides the names", () => {
    const url = new URL(splitUrl("https://x.test", ID, dinner));
    const tampered = parseSplitFragment(url.hash.replace("Sam", "Samuel"));
    assert.equal(memoMatches(tampered, memoHash(dinner)), false);
    assert.equal(memoMatches(null, memoHash(dinner)), false);
    assert.equal(parseSplitFragment(""), null);
  });

  it("are cleaned: control characters out, lengths capped", () => {
    const parsed = parseSplitFragment(`#d=${encodeURIComponent("Dinner\u0007 at Lucia" + "x".repeat(100))}&n=Maya&t=12&l=${encodeURIComponent("A\u0000B")}`);
    assert.ok(parsed);
    assert.equal(parsed.description.length, 60);
    assert.ok(!parsed.description.includes("\u0007"));
    assert.deepEqual(parsed.labels, ["AB"]);
  });
});

describe("a create form filled in from its URL (polarispay-sdk splits.link)", () => {
  it("fills the bill, the words and an equal split with names", () => {
    const p = splitPrefill(new URLSearchParams("amount=120&description=Dinner%20at%20Lucia&people=4&name=Sam&name=Priya&name=Jon"));
    assert.deepEqual(p, { amount: "120", description: "Dinner at Lucia", people: 4, names: ["Sam", "Priya", "Jon"] });
    assert.deepEqual(splitPrefill(new URLSearchParams("amount=60&people=3&include_me=0")), { amount: "60", people: 3, includeMe: false });
  });

  it("fills named amounts, and they win over an equal split", () => {
    const p = splitPrefill(new URLSearchParams("amount=120&share=Sam:45&share=Priya:30.50&people=4"));
    assert.deepEqual(p, { amount: "120", mode: "custom", rows: [{ name: "Sam", amount: "45" }, { name: "Priya", amount: "30.50" }] });
  });

  it("leaves out anything malformed rather than guess", () => {
    const p = splitPrefill(new URLSearchParams("amount=12.345&people=99&share=:5&share=Sam:abc&name="));
    assert.deepEqual(p, {});
  });
});
