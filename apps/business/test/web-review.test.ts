import type { MerchantRecord } from "@polaris/db";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as health, POST as healthPost } from "@/app/api/health/route";
import { GET as listLinks, POST as createLink } from "@/app/api/links/route";
import { GET as me } from "@/app/api/me/route";
import { GET as overview } from "@/app/api/overview/route";
import { GET as payoutsGet, POST as withdraw } from "@/app/api/payouts/route";
import { POST as automatic } from "@/app/api/payouts/automatic/route";
import { GET as relayGet } from "@/app/api/relay/route";
import { readToken } from "@/server/auth";
import { getDb } from "@/server/db";
import { resetConfig } from "@/server/env";
import { safeNext } from "@/lib/next-path";

import { DEPLOYMENT, json, params, request, setupServer, signIn, type TestEnv } from "./helpers/env";

/**
 * The web review's server findings: a server with no chain shows an empty
 * book (never an invented one), links that can't work are refused, the health route keeps its problems private, a bad
 * cookie is a 401, and unsupported methods answer in JSON.
 */

const WALLET = "0x2222222222222222222222222222222222222222";
const DESTINATION = "0x3333333333333333333333333333333333333333";
const LINK = { amountCents: 30_00, description: "Monthly box", modes: ["subscribe"], usage: "single", expiresInHours: null };

let env: TestEnv;

beforeEach(() => {
  env = setupServer();
  signIn({ userId: "did:privy:review", walletAddress: WALLET });
});

describe("a server with no chain", () => {
  it("shows the merchant an empty book, never an invented one, and the same merchant once the chain is connected", async () => {
    setupServer({ POLARIS_DEPLOYMENT_FILE: "does-not-exist.json", RELAYER_MODE: "off" });
    signIn({ userId: "did:privy:review", walletAddress: WALLET });
    const before = await json(await me(request("GET", "/api/me"), params({})));
    expect(before.status).toBe(200);
    expect(before.body.data).not.toHaveProperty("sample");

    const empty = await json(await overview(request("GET", "/api/overview"), params({})));
    expect(empty.body.data).toMatchObject({ balanceCents: 0, today: { count: 0, payments: [] }, exposure: { outstandingCents: 0, collectionRate: null } });
    expect(empty.body.data).not.toHaveProperty("sample");
    const nothingPaidOut = await json(await payoutsGet(request("GET", "/api/payouts"), params({})));
    expect(nothingPaidOut.body.data).toMatchObject({ balanceCents: 0, history: [] });

    // Nothing moves without the payout wallet's signature, chain or not.
    const unsigned = await json(await withdraw(request("POST", "/api/payouts", { body: { amountCents: 100, destination: DESTINATION } }), params({})));
    expect(unsigned.status).toBe(400);
    expect(unsigned.body.error.code).toBe("signature_required");

    // Connect the chain and reload the config: no restart, the same merchant.
    process.env.POLARIS_DEPLOYMENT_FILE = DEPLOYMENT;
    process.env.RELAYER_MODE = "local";
    resetConfig();
    const after = await json(await me(request("GET", "/api/me"), params({})));
    expect(after.body.data.publicId).toBe(before.body.data.publicId);
  });

  it("lists only the merchant's own links", async () => {
    setupServer({ POLARIS_DEPLOYMENT_FILE: "does-not-exist.json", RELAYER_MODE: "off" });
    signIn({ userId: "did:privy:review", walletAddress: WALLET });
    const created = await json(await createLink(request("POST", "/api/links", { body: { ...LINK, modes: ["now"] } }), params({})));
    const links = await json(await listLinks(request("GET", "/api/links"), params({})));
    expect((links.body.data as { id: string }[]).map((l) => l.id)).toEqual([created.body.data.id]);
  });

  it("clears an invented book an older build left behind: the flag and its withdrawals", async () => {
    const db = getDb();
    const { ensureMerchant } = await import("@/server/merchants");
    const auth = { userId: "did:privy:review", walletAddress: WALLET, walletId: null, email: null, sessionId: "s" } as const;
    const merchant = await ensureMerchant(auth);
    await db.merchants.update(merchant.id, (m) => ({ ...m, sample: true, sampleBalanceCents: 1_000_00 }));
    await db.payouts.insert({
      id: "po_legacy",
      merchantId: merchant.id,
      kind: "manual",
      state: "queued",
      amountUnits: "1000000",
      from: WALLET,
      destination: DESTINATION,
      authorizationNonce: null,
      txHash: null,
      error: null,
      createdAt: new Date().toISOString(),
      paidAt: null,
      sample: true,
    });

    const payouts = await json(await payoutsGet(request("GET", "/api/payouts"), params({})));
    expect(payouts.body.data.history).toEqual([]);
    expect(await db.payouts.get("po_legacy")).toBeNull();
    expect(await db.merchants.get(merchant.id)).toMatchObject({ sample: false, sampleBalanceCents: 0 });
  });
});

describe("links", () => {
  it("refuse a single-use subscription: it would be charged once", async () => {
    const res = await json(await createLink(request("POST", "/api/links", { body: LINK }), params({})));
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("usage");
  });

  it("count only active links against the cap", async () => {
    const db = getDb();
    const { ensureMerchant } = await import("@/server/merchants");
    const merchant = await ensureMerchant({ userId: "did:privy:review", walletAddress: WALLET, walletId: null, email: null, sessionId: "s" });
    const now = new Date().toISOString();
    for (let i = 0; i < 500; i++) {
      await db.links.insert({
        id: `pl_cap${i}`,
        merchantId: merchant.id,
        url: "",
        amountCents: 100,
        description: "x",
        modes: ["now"],
        usage: "reusable",
        expiresAt: null,
        status: i < 10 ? "inactive" : "active",
        paymentsCount: 0,
        collectedCents: 0,
        createdAt: now,
      });
    }
    const body = { ...LINK, modes: ["now"], usage: "reusable" };
    for (let i = 0; i < 10; i++) {
      const res = await createLink(request("POST", "/api/links", { body }), params({}));
      expect(res.status).toBe(201);
    }
    const over = await json(await createLink(request("POST", "/api/links", { body }), params({})));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("limit_reached");
  });
});

describe("registration", () => {
  it("left at submitted moves on when the registry shows it", async () => {
    const { ensureMerchant } = await import("@/server/merchants");
    const merchant = await ensureMerchant({ userId: "did:privy:review", walletAddress: WALLET, walletId: null, email: null, sessionId: "s" });
    await getDb().merchants.update(merchant.id, (m: MerchantRecord) => ({ ...m, registration: { ...m.registration, state: "submitted" } }));
    env.chain.reads.merchantOf = () => ({ payoutAddress: WALLET, name: "", registeredAt: 1n, active: false, maxOrderValue: 0n });

    const res = await json(await me(request("GET", "/api/me"), params({})));
    expect(res.body.data.registration.state).toBe("registered");
  });
});

describe("automatic payouts", () => {
  it("turn off without the wallet", async () => {
    signIn({ userId: "did:privy:no-wallet", walletAddress: null });
    const res = await json(await automatic(request("POST", "/api/payouts/automatic", { body: { enabled: false } }), params({})));
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });
});

describe("health", () => {
  it("says whether production is ready, not what's wrong", async () => {
    const res = await json(await health(request("GET", "/api/health"), params({})));
    expect(res.status).toBe(200);
    expect(res.body.data.problems).toBeUndefined();
    expect(typeof res.body.data.productionReady).toBe("boolean");
    expect(res.body.data.ready).toBeUndefined();
    expect(res.body.data.checkoutOrigin).toBe("http://localhost:3000");
  });

  it("has its own rate-limit bucket: checkout reads can't use it up", async () => {
    for (let i = 0; i < 75; i++) expect((await health(request("GET", "/api/health"), params({}))).status).toBe(200);
  });
});

describe("requests", () => {
  it("with a malformed privy-token cookie are unauthenticated, not a 500", () => {
    expect(readToken(new Request("http://localhost/api/me", { headers: { cookie: "privy-token=%" } }))).toBeNull();
    expect(readToken(new Request("http://localhost/api/me", { headers: { cookie: "privy-token=%E0%A4%A" } }))).toBeNull();
    expect(readToken(new Request("http://localhost/api/me", { headers: { cookie: "privy-token=abc" } }))).toEqual({ token: "abc", source: "cookie" });
  });

  it("with an unsupported method get a JSON 405 on the public and relay routes too", async () => {
    for (const res of [await healthPost(request("POST", "/api/health"), params({})), await relayGet(request("GET", "/api/relay"), params({}))]) {
      expect(res.status).toBe(405);
      expect((await res.json()).error.code).toBe("method_not_allowed");
    }
  });
});

describe("next", () => {
  it("stays in the dashboard after resolving dot segments", () => {
    expect(safeNext("/dashboard/../api/health")).toBe("/dashboard");
    expect(safeNext("/dashboard/../../evil")).toBe("/dashboard");
    expect(safeNext("/dashboard/links?new=1")).toBe("/dashboard/links?new=1");
    expect(safeNext("/payments")).toBe("/dashboard/payments");
  });
});
