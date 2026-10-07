import { describe, expect, it } from "vitest";
import { handleFxRequest } from "../src/http.ts";
import type { FxLookup, FxService } from "../src/service.ts";

const ARS: FxLookup = {
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

function fakeService(): FxService & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async lookup(currency) {
      asked.push(currency);
      return currency === "ARS" ? ARS : { currency, status: "no-feed", rate: null };
    },
    clear() {},
  };
}

const get = (query: string, service = fakeService()) => handleFxRequest(service, new Request(`http://localhost/api/fx${query}`));

describe("GET /api/fx", () => {
  it("answers a rate with its source, cacheable for a minute", async () => {
    const res = await get("?currency=ars");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=240");
    expect(await res.json()).toEqual(ARS);
  });

  it("answers 200 with no rate when there is none, cacheable for 30 s", async () => {
    const res = await get("?currency=CLP");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(await res.json()).toEqual({ currency: "CLP", status: "no-feed", rate: null });
  });

  it("refuses anything but a three-letter code, without a lookup", async () => {
    const service = fakeService();
    for (const query of ["", "?currency=", "?currency=AR", "?currency=ARSS", "?currency=A%20S", "?currency=../x", "?currency=12%24"]) {
      const res = await get(query, service);
      expect(res.status, query).toBe(400);
    }
    expect(service.asked).toEqual([]);
  });
});
