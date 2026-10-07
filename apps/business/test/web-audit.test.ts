import { beforeEach, describe, expect, it } from "vitest";

import { GET as unknownPath } from "@/app/api/[...path]/route";
import { POST as createLink } from "@/app/api/links/route";
import { PATCH as updateLink } from "@/app/api/links/[id]/route";
import { POST as setName, PUT as putMe } from "@/app/api/me/route";
import { POST as withdraw } from "@/app/api/payouts/route";
import { POST as openLink } from "@/app/api/public/links/[id]/checkout/route";

import { getDb } from "@/server/db";

import { json, params, request, setupServer, signIn } from "./helpers/env";

/**
 * The web audit's fixes that sit on top of the merged backend: link
 * deactivation, JSON 404/405s, field-named validation errors, checksummed
 * money destinations and the per-merchant write limit.
 */

const WALLET = "0x2222222222222222222222222222222222222222";
const LINK = { amountCents: 200_00, description: "Brand identity package", modes: ["now", "later"], usage: "reusable", expiresInHours: null };

beforeEach(() => {
  setupServer();
  signIn({ userId: "did:privy:audit", walletAddress: WALLET });
});

describe("links", () => {
  it("turn off, and an inactive link opens no checkout", async () => {
    const created = await json(await createLink(request("POST", "/api/links", { body: LINK }), params({})));
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(id).toMatch(/^pl_/);

    const off = await json(await updateLink(request("PATCH", `/api/links/${id}`, { body: { active: false } }), params({ id })));
    expect(off.status).toBe(200);
    expect(off.body.data.status).toBe("inactive");

    const opened = await json(await openLink(request("POST", `/api/public/links/${id}/checkout`), params({ id })));
    expect(opened.status).toBe(410);
    expect(opened.body.error.code).toBe("link_inactive");
  });

  it("tell a turned-off link from an expired one, so the buyer's checkout can say which (R1 A7)", async () => {
    const off = await json(await createLink(request("POST", "/api/links", { body: LINK }), params({})));
    const offId = off.body.data.id as string;
    await updateLink(request("PATCH", `/api/links/${offId}`, { body: { active: false } }), params({ id: offId }));
    const expired = await json(await createLink(request("POST", "/api/links", { body: { ...LINK, expiresInHours: 1 } }), params({})));
    const expiredId = expired.body.data.id as string;
    await getDb().links.update(expiredId, (l) => ({ ...l, expiresAt: new Date(Date.now() - 1000).toISOString() }));

    const a = await json(await openLink(request("POST", `/api/public/links/${offId}/checkout`), params({ id: offId })));
    const b = await json(await openLink(request("POST", `/api/public/links/${expiredId}/checkout`), params({ id: expiredId })));
    expect([a.status, a.body.error.code]).toEqual([410, "link_inactive"]);
    expect([b.status, b.body.error.code]).toEqual([410, "link_expired"]);
    expect(a.body.error.message).toMatch(/turned off/);
  });

  it("only turn off: any other change is refused, naming the field", async () => {
    const created = await json(await createLink(request("POST", "/api/links", { body: LINK }), params({})));
    const id = created.body.data.id as string;
    const res = await json(await updateLink(request("PATCH", `/api/links/${id}`, { body: { active: true } }), params({ id })));
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("active");
  });

  it("belong to their merchant: another merchant gets a 404", async () => {
    const created = await json(await createLink(request("POST", "/api/links", { body: LINK }), params({})));
    const id = created.body.data.id as string;
    signIn({ userId: "did:privy:someone-else", walletAddress: "0x3333333333333333333333333333333333333333" });
    const res = await json(await updateLink(request("PATCH", `/api/links/${id}`, { body: { active: false } }), params({ id })));
    expect(res.status).toBe(404);
  });
});

describe("responses", () => {
  it("answer an unsupported method with a JSON 405 and Allow", async () => {
    const res = await putMe(request("PUT", "/api/me", { body: {} }), params({}));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
    expect((await res.json()).error.code).toBe("method_not_allowed");
  });

  it("answer an unknown /api path with a JSON 404, behind sign-in", async () => {
    const res = await json(await unknownPath(request("GET", "/api/nope"), { params: Promise.resolve({ path: ["nope"] }) }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("write validation errors for people, with the field in `param`", async () => {
    const res = await json(await createLink(request("POST", "/api/links", { body: { ...LINK, amountCents: 12.5 } }), params({})));
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("amountCents");
    expect(res.body.error.message).not.toMatch(/amountCents/);
  });

  it("refuse a mixed-case destination whose checksum is wrong", async () => {
    const res = await json(
      await withdraw(request("POST", "/api/payouts", { body: { amountCents: 1234, destination: "0xAbCDEF1234567890abcdef1234567890ABCDEF12" } }), params({})),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("destination");
    expect(res.body.error.message).toMatch(/checksum/);
  });
});

describe("writes", () => {
  it("are rate limited per merchant, with Retry-After", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await setName(request("POST", "/api/me", { body: { businessName: `Studio ${i}` } }), params({}));
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
