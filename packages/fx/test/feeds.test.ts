import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { CHAINS, FX_CURRENCIES, FX_FEEDS, feedsFor, hasFxFeed, NO_FEED, quotesLocalPerUsd } from "../src/feeds.ts";

/** Every currency the customer app has offered (money.ts's list before live rates). */
const APP_CURRENCIES = [
  "ARS", "BRL", "MXN", "COP", "CLP", "PEN", "GBP", "EUR", "CHF", "SEK", "NOK", "PLN", "TRY", "PHP", "INR", "PKR", "IDR",
  "VND", "THB", "MYR", "SGD", "JPY", "KRW", "CNY", "NGN", "KES", "GHS", "ZAR", "EGP", "AED", "CAD", "AUD", "NZD",
];

describe("the feed table", () => {
  it("accounts for every currency the app offers: a feed, or listed as having none", () => {
    for (const code of APP_CURRENCIES) expect(hasFxFeed(code) || NO_FEED.includes(code), code).toBe(true);
    expect(NO_FEED.filter((c) => hasFxFeed(c))).toEqual([]);
  });

  it("covers the currencies the send story needs", () => {
    for (const code of ["ARS", "PHP", "BRL", "MXN", "INR", "NGN", "EUR", "GBP", "JPY", "CHF", "CAD"]) expect(hasFxFeed(code), code).toBe(true);
  });

  it("reads EUR, GBP, JPY, CHF and CAD from Monad mainnet first", () => {
    for (const code of ["EUR", "GBP", "JPY", "CHF", "CAD"]) expect(feedsFor(code)?.sources[0]?.chain, code).toBe("monad");
    // Monad's FX feeds report 18 decimals and update every 240 s.
    for (const code of ["EUR", "GBP", "JPY", "CHF", "CAD"]) {
      expect(feedsFor(code)?.sources[0]).toMatchObject({ decimals: 18, heartbeatSeconds: 240 });
    }
  });

  it("lists each currency once, with checksummed addresses and a pair that names it", () => {
    expect(new Set(FX_CURRENCIES).size).toBe(FX_FEEDS.length);
    for (const { currency, sources } of FX_FEEDS) {
      expect(sources.length).toBeGreaterThan(0);
      // A fallback is on another chain, or it would share the first one's outage.
      expect(new Set(sources.map((s) => s.chain)).size, currency).toBe(sources.length);
      for (const s of sources) {
        expect(getAddress(s.address), `${currency} ${s.address}`).toBe(s.address);
        expect([`${currency} / USD`, `USD / ${currency}`]).toContain(s.pair);
        expect(Object.keys(CHAINS)).toContain(s.chain);
        expect([8, 18]).toContain(s.decimals);
        expect(s.heartbeatSeconds).toBeGreaterThan(0);
      }
    }
  });

  it("never mixes the two different ARS rates", () => {
    const pairs = new Set(feedsFor("ARS")?.sources.map((s) => s.pair));
    expect([...pairs]).toEqual(["USD / ARS"]);
  });

  it("finds feeds case-insensitively and says nothing for unknown codes", () => {
    expect(feedsFor("ars")?.currency).toBe("ARS");
    expect(feedsFor("CLP")).toBeUndefined();
    expect(hasFxFeed("USD")).toBe(false);
  });

  it("knows which way a pair is quoted", () => {
    expect(quotesLocalPerUsd("USD / ARS")).toBe(true);
    expect(quotesLocalPerUsd("EUR / USD")).toBe(false);
  });

  it("points each chain at its own chain id", () => {
    expect(CHAINS.monad.id).toBe(143);
    expect(CHAINS.ethereum.id).toBe(1);
    expect(CHAINS.polygon.id).toBe(137);
    expect(CHAINS.base.id).toBe(8453);
  });
});
