import { encodeErrorResult } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { polarisLoanEngineAbi } from "@polarispay/contracts/abi";
import { POST as relayRoute } from "@/app/api/relay/route";
import { GET as publicGet } from "@/app/api/public/sessions/[id]/route";
import { clientIp, HttpError } from "@/server/http";
import { bucketCountForTests, consume, resetRateLimitsForTests } from "@/server/ratelimit";

import { json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { emitLikeTheContracts, merchantWithKeys, newSession, signPayNow, type Merchant } from "./helpers/flows";

let env: TestEnv;
let merchant: Merchant;
const victim = privateKeyToAccount(generatePrivateKey());

const relayFrom = (ip: string, body: unknown) => relayRoute(request("POST", "/api/relay", { body, headers: { "x-forwarded-for": ip } }), params({}));

async function payBody(session: Record<string, any>, signer = victim) {
  const auth = await signPayNow(signer, merchant.account.address, session.orderId, 200_000_000n);
  return { type: "pay", sessionId: session.id, buyer: victim.address, ...auth };
}

function setup(extra: Record<string, string> = {}) {
  env = setupServer(extra);
  emitLikeTheContracts(env);
}

describe("per-signer relay limits count only verified signatures", () => {
  beforeEach(async () => {
    setup();
    merchant = await merchantWithKeys();
  });

  it("junk requests naming a buyer don't lock that buyer out of checkout (the reported attack: 6 junk 'pay's)", async () => {
    const session = await newSession(merchant);
    const junk = { ...(await payBody(session)), signature: `0x${"11".repeat(65)}` };
    for (let i = 0; i < 10; i++) expect((await relayFrom("198.51.100.66", junk)).status).toBe(400);
    const genuine = await json(await relayFrom("203.0.113.5", await payBody(session)));
    expect(genuine.status).toBe(200);
    expect(genuine.body.data.status).toBe("confirmed");
  });

  it("a stranger's signature for the buyer's session doesn't count against the buyer either", async () => {
    const session = await newSession(merchant);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const forged = await payBody(session, stranger);
    for (let i = 0; i < 8; i++) expect((await json(await relayFrom("198.51.100.67", forged))).body.error.code).toBe("invalid_signature");
    expect((await relayFrom("203.0.113.5", await payBody(session))).status).toBe(200);
  });

  it("still limits an account's own verified requests", async () => {
    const session = await newSession(merchant);
    env.chain.reverts.set("pay", encodeErrorResult({ abi: polarisLoanEngineAbi, errorName: "ExceedsCreditLimit" }));
    const body = await payBody(session);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await relayFrom("203.0.113.5", body)).status);
    expect(statuses.slice(0, 6).every((s) => s === 402)).toBe(true);
    expect(statuses).toContain(429);
  });
});

describe("per-IP limits key on the client's address", () => {
  it("without a proxy, each client has its own bucket (not one shared 'local' key)", async () => {
    setup();
    merchant = await merchantWithKeys();
    const session = await newSession(merchant);
    const junk = { ...(await payBody(session)), signature: `0x${"22".repeat(65)}` };
    const flood: number[] = [];
    for (let i = 0; i < 17; i++) flood.push((await relayFrom("198.51.100.1", junk)).status);
    expect(flood.at(-1)).toBe(429);
    // Everyone else is untouched.
    expect((await relayFrom("203.0.113.9", await payBody(session))).status).toBe(200);
    const read = await publicGet(request("GET", `/api/public/sessions/${session.id}`, { headers: { "x-forwarded-for": "203.0.113.10" } }), params({ id: session.id }));
    expect(read.status).toBe(200);
  });

  it("behind a proxy, a client can't pick its own key by varying X-Forwarded-For (the reported bypass: 16 values, 15 x 400 then 429)", async () => {
    setup({ POLARIS_TRUSTED_PROXIES: "1" });
    merchant = await merchantWithKeys();
    const session = await newSession(merchant);
    const junk = { ...(await payBody(session)), signature: `0x${"33".repeat(65)}` };
    const statuses: number[] = [];
    // The proxy appends the address it saw (198.51.100.2); the client varies what's left of it.
    for (let i = 0; i < 16; i++) statuses.push((await relayFrom(`10.0.0.${i}, 198.51.100.2`, junk)).status);
    expect(statuses.slice(0, 15).every((s) => s === 400)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it("refuses a request it can't place rather than pooling it with everyone", async () => {
    setup();
    const res = await json(await relayRoute(new Request("http://localhost:3100/api/relay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), params({})));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("client_unidentified");
  });

  it("clientIp reads X-Forwarded-For from the right", () => {
    const req = (xff: string | null, extra: Record<string, string> = {}) => new Request("http://x", { headers: { ...(xff === null ? {} : { "x-forwarded-for": xff }), ...extra } });
    expect(clientIp(req("1.1.1.1"), 0)).toBe("1.1.1.1");
    expect(clientIp(req("6.6.6.6, 1.1.1.1"), 0)).toBe("1.1.1.1");
    expect(clientIp(req("6.6.6.6, 1.1.1.1"), 1)).toBe("1.1.1.1");
    expect(clientIp(req("6.6.6.6, 1.1.1.1, 10.0.0.2"), 2)).toBe("1.1.1.1");
    expect(clientIp(req("1.1.1.1"), 2)).toBe("1.1.1.1");
    expect(clientIp(req(null, { "x-real-ip": "2.2.2.2" }), 1)).toBe("2.2.2.2");
    expect(clientIp(req(null, { "x-real-ip": "2.2.2.2" }), 0)).toBeNull();
    expect(clientIp(req(" , "), 0)).toBeNull();
  });
});

describe("the bucket map", () => {
  it("evicts the least recently used bucket instead of clearing everyone's", () => {
    resetRateLimitsForTests({ maxBuckets: 3 });
    const limit = { name: "t", perMinute: 1, burst: 1 };
    const t = 1_000_000;
    consume(limit, "abuser", t);
    expect(() => consume(limit, "abuser", t)).toThrow(HttpError);
    consume(limit, "y", t);
    expect(() => consume(limit, "abuser", t)).toThrow(HttpError); // touched: now the most recent
    consume(limit, "z", t);
    consume(limit, "w", t); // full: drops "y", the least recently used
    expect(bucketCountForTests()).toBe(3);
    expect(() => consume(limit, "abuser", t)).toThrow(HttpError); // still limited
    consume(limit, "y", t); // "y" starts afresh
    resetRateLimitsForTests();
  });
});
