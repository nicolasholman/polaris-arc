import { describe, expect, it } from "vitest";
import { formatLocalAmount, isFreshRate, localAmount, parseFxLookup, rateAgeText } from "../src/display.ts";

const usd = (dollars: number) => BigInt(Math.round(dollars * 1e6));
/** Intl puts a no-break space between the code and the number. */
const plain = (s: string | null) => s?.replace(/ /g, " ") ?? null;

describe("formatLocalAmount", () => {
  it("prints the currency code, never a symbol that reads as dollars", () => {
    expect(plain(formatLocalAmount(usd(100), "ARS", 1612.4065, "en-US"))).toBe("ARS 161,241");
    expect(plain(formatLocalAmount(usd(100), "ARS", 1612.4065, "es-AR"))).toBe("ARS 161.241");
    expect(plain(formatLocalAmount(usd(100), "ARS", 1612.4065, "de-DE"))).toBe("161.241 ARS");
  });

  it("keeps the currency's usual decimals under 1,000", () => {
    expect(plain(formatLocalAmount(usd(5), "EUR", 0.8785023, "en-US"))).toBe("EUR 4.39");
    expect(plain(formatLocalAmount(usd(5), "JPY", 157.505, "en-US"))).toBe("JPY 788");
  });

  it("shows nothing for dollars, a bad rate or an unusable locale", () => {
    expect(formatLocalAmount(usd(5), "USD", 1, "en-US")).toBeNull();
    expect(formatLocalAmount(usd(5), "EUR", 0, "en-US")).toBeNull();
    expect(formatLocalAmount(usd(5), "EUR", Number.NaN, "en-US")).toBeNull();
    expect(formatLocalAmount(usd(5), "EUR", 0.87, "not a locale!")).toBeNull();
  });

  it("converts base units exactly enough", () => {
    expect(localAmount(usd(25), 17.7224)).toBeCloseTo(443.06, 2);
  });
});

describe("rate age", () => {
  const updatedAt = 1_790_543_663;
  const at = (seconds: number) => (updatedAt + seconds) * 1000;

  it("reads like a person would say it", () => {
    expect(rateAgeText(updatedAt, at(30))).toBe("just now");
    expect(rateAgeText(updatedAt, at(-20))).toBe("just now");
    expect(rateAgeText(updatedAt, at(3 * 60 + 10))).toBe("3 min ago");
    expect(rateAgeText(updatedAt, at(5 * 3600 + 59))).toBe("5 h ago");
  });

  it("is fresh up to 26 hours and not a second more", () => {
    expect(isFreshRate(updatedAt, at(26 * 3600))).toBe(true);
    expect(isFreshRate(updatedAt, at(26 * 3600 + 1))).toBe(false);
  });
});

describe("parseFxLookup", () => {
  const ok = {
    currency: "ARS",
    status: "ok",
    rate: {
      currency: "ARS",
      perUsd: 1612.4065,
      updatedAt: 1_790_543_663,
      maxAgeSeconds: 93_600,
      source: { chain: "ethereum", chainId: 1, address: "0xBb65fa58BDb7d33e4a3D1A40a7A9BD99E746367b", pair: "USD / ARS", decimals: 8, roundId: "18446744073709551862" },
    },
  };

  it("accepts a well-formed rate", () => {
    expect(parseFxLookup(ok)).toEqual(ok);
  });

  it("keeps the rate's own source limit, and gives an older API's rate the 26 h cap", () => {
    const monad = { ...ok, rate: { ...ok.rate, maxAgeSeconds: 840 } };
    expect(parseFxLookup(monad)).toEqual(monad);
    const { maxAgeSeconds: _, ...older } = ok.rate;
    expect(parseFxLookup({ ...ok, rate: older })?.rate?.maxAgeSeconds).toBe(26 * 3600);
    expect(parseFxLookup({ ...ok, rate: { ...ok.rate, maxAgeSeconds: 10 ** 9 } })?.rate?.maxAgeSeconds).toBe(26 * 3600);
    expect(parseFxLookup({ ...ok, rate: { ...ok.rate, maxAgeSeconds: -5 } })?.rate?.maxAgeSeconds).toBe(26 * 3600);
  });

  it("passes the no-rate answers through", () => {
    for (const status of ["no-feed", "stale", "unavailable"]) {
      expect(parseFxLookup({ currency: "CLP", status, rate: null })).toEqual({ currency: "CLP", status, rate: null });
    }
  });

  it("refuses anything malformed", () => {
    expect(parseFxLookup(null)).toBeNull();
    expect(parseFxLookup("ARS 1612")).toBeNull();
    expect(parseFxLookup({ ...ok, status: "great" })).toBeNull();
    expect(parseFxLookup({ ...ok, rate: { ...ok.rate, perUsd: -1 } })).toBeNull();
    expect(parseFxLookup({ ...ok, rate: { ...ok.rate, perUsd: "1612" } })).toBeNull();
    expect(parseFxLookup({ ...ok, rate: { ...ok.rate, updatedAt: 1.5 } })).toBeNull();
    expect(parseFxLookup({ ...ok, rate: { ...ok.rate, source: { ...ok.rate.source, chain: "solana" } } })).toBeNull();
    expect(parseFxLookup({ ...ok, rate: { ...ok.rate, source: { ...ok.rate.source, address: "0x123" } } })).toBeNull();
    expect(parseFxLookup({ ...ok, rate: null })).toBeNull();
  });
});
