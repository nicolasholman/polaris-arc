import { describe, expect, it, vi } from "vitest";

import { createPolaris } from "../src/client.js";
import { PolarisError } from "../src/errors.js";
import { createPolarisServer } from "../src/server/client.js";
import { splitLink, type SplitStatus } from "../src/splits.js";

/**
 * Split-the-bill links: an app hands the organiser the Polaris app's "Split a
 * bill" screen filled in (nothing is created until they confirm there with
 * Face ID), and a server reads a split's status by its id.
 */

const APP = "http://localhost:3000";
const ID = `0x${"ab".repeat(32)}`;

describe("splits.link", () => {
  it("fills in an equal split: the bill, what it's for, how many people and their names", () => {
    const url = new URL(splitLink(APP, { total: "120", description: "Dinner at Lucia", people: 4, names: ["Sam", "Priya", "Jon"] }));
    expect(url.origin + url.pathname).toBe(`${APP}/split/new`);
    expect(url.searchParams.get("amount")).toBe("120.00");
    expect(url.searchParams.get("description")).toBe("Dinner at Lucia");
    expect(url.searchParams.get("people")).toBe("4");
    expect(url.searchParams.getAll("name")).toEqual(["Sam", "Priya", "Jon"]);
    expect(url.searchParams.get("include_me")).toBeNull();
    expect(new URL(splitLink(APP, { total: 60, people: 3, includeOrganiser: false })).searchParams.get("include_me")).toBe("0");
  });

  it("fills in named amounts instead, as name:amount", () => {
    const url = new URL(splitLink(`${APP}/`, { total: "120.00", shares: [{ name: "Sam", amount: "45" }, { name: "Priya", amount: 30.5 }] }));
    expect(url.searchParams.getAll("share")).toEqual(["Sam:45.00", "Priya:30.50"]);
    expect(url.searchParams.get("people")).toBeNull();
  });

  it("refuses what the app would refuse: no bill, too many people, a nameless share, a long description", () => {
    expect(() => splitLink(APP, { total: "0" })).toThrow(PolarisError);
    expect(() => splitLink(APP, { total: "10", people: 21 })).toThrow(/2 to 20/);
    expect(() => splitLink(APP, { total: "10", people: 1 })).toThrow(/2 to 20/);
    expect(() => splitLink(APP, { total: "10", shares: [{ name: " ", amount: "5" }] })).toThrow(/name is required/);
    expect(() => splitLink(APP, { total: "10", description: "x".repeat(61) })).toThrow(/60 characters/);
  });

  it("is on the browser client, against its checkout origin, and open() uses a new tab", () => {
    const polaris = createPolaris({ publishableKey: "pk_test_51Hx8yQfT3sLk2PzR9vWc", checkoutOrigin: "https://pay.polarispay.app" });
    expect(polaris.splits.link({ total: "30", people: 2 })).toBe("https://pay.polarispay.app/split/new?amount=30.00&people=2");
    const open = vi.fn();
    vi.stubGlobal("open", open);
    try {
      polaris.splits.open({ total: "30", people: 2 });
      expect(open).toHaveBeenCalledWith("https://pay.polarispay.app/split/new?amount=30.00&people=2", "_blank", "noopener");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("splits.retrieve on the server client", () => {
  const split: SplitStatus = {
    id: ID,
    organiser: "0x1111111111111111111111111111111111111111",
    status: "open",
    totalUnits: "90000000",
    paidUnits: "30000000",
    shareCount: 3,
    paidCount: 1,
    expiresAt: "2026-10-12T12:00:00.000Z",
    memoHash: `0x${"cd".repeat(32)}`,
    shares: [
      { index: 0, amountUnits: "30000000", paid: true, payer: "0x2222222222222222222222222222222222222222", paidAt: "2026-09-28T12:00:00.000Z", txHash: `0x${"ef".repeat(32)}`, explorerUrl: null },
      { index: 1, amountUnits: "30000000", paid: false, payer: null, paidAt: null, txHash: null, explorerUrl: null },
      { index: 2, amountUnits: "30000000", paid: false, payer: null, paidAt: null, txHash: null, explorerUrl: null },
    ],
    createdAt: "2026-09-28T11:00:00.000Z",
    createdTxHash: `0x${"12".repeat(32)}`,
    closedAt: null,
  };

  it("reads GET /api/public/splits/{id}", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: split }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const polaris = createPolarisServer({ secretKey: "sk_test_51Hx8yQfT3sLk2PzR9vWc", baseUrl: "http://localhost:3100", fetch, sleep: async () => {} });
    expect(await polaris.splits.retrieve(ID.toUpperCase().replace("0X", "0x"))).toEqual(split);
    expect(calls).toEqual([`http://localhost:3100/api/public/splits/${ID}`]);
  });

  it("refuses a malformed id before any request", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const polaris = createPolarisServer({ secretKey: "sk_test_51Hx8yQfT3sLk2PzR9vWc", baseUrl: "http://localhost:3100", fetch });
    await expect(polaris.splits.retrieve("0x1234")).rejects.toThrow(/64 hex characters/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
