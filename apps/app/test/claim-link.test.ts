import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { claimUrl, parseClaimFragment } from "../src/lib/links.ts";
import { eur, money, usd } from "../src/lib/money.ts";

/**
 * Send links carry their currency: dollars (no `c`, so every older link
 * still claims) or euros (`c=EUR`), which claim and cancel on the PolarisSend
 * deployed on EURC.
 */

const KEY = `0x${"ab".repeat(32)}` as const;

describe("a send link's currency", () => {
  it("leaves dollars unmarked and marks euros with c=EUR", () => {
    const dollars = claimUrl("https://app.example", { key: KEY, amount: 25_000_000n, name: "Maya", currency: "USD" });
    const euros = claimUrl("https://app.example", { key: KEY, amount: 25_500_000n, name: "Maya", currency: "EUR" });
    assert.equal(dollars, `https://app.example/claim#k=${KEY}&a=25&n=Maya`);
    assert.equal(euros, `https://app.example/claim#k=${KEY}&a=25.5&n=Maya&c=EUR`);
  });

  it("reads the currency back, defaulting to dollars", () => {
    assert.deepEqual(parseClaimFragment(`#k=${KEY}&a=25&n=Maya`), { key: KEY, amount: 25_000_000n, name: "Maya", currency: "USD" });
    assert.deepEqual(parseClaimFragment(`#k=${KEY}&a=25.5&n=Maya&c=EUR`), { key: KEY, amount: 25_500_000n, name: "Maya", currency: "EUR" });
    assert.deepEqual(parseClaimFragment(`#k=${KEY}&a=25&c=eur`), { key: KEY, amount: 25_000_000n, name: "Someone", currency: "EUR" });
  });

  it("refuses a link with a currency Polaris doesn't hold, or a missing part", () => {
    assert.deepEqual(parseClaimFragment(`#k=${KEY}&a=25&c=GBP`), { invalid: true });
    assert.deepEqual(parseClaimFragment(`#k=0x12&a=25`), { invalid: true });
    assert.deepEqual(parseClaimFragment(`#k=${KEY}&a=0`), { invalid: true });
  });
});

describe("amounts in each currency", () => {
  it("formats dollars and euros from the same 6-decimal units", () => {
    assert.equal(usd(1_284_500_000n), "$1,284.50");
    assert.equal(eur(1_284_500_000n), "€1,284.50");
    assert.equal(money(50_000_000n, "EUR", { trim: true }), "€50");
    assert.equal(eur(-2_005_000n), "−€2.01");
  });
});
