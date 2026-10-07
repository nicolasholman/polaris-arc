import { concat, encodeFunctionData, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as crePost } from "@/app/api/cre/callback/route";
import { POST as underwritePost } from "@/app/api/credit/underwrite/route";
import { GET as creditGet } from "@/app/api/public/credit/[account]/route";
import { GET as messagesGet } from "@/app/api/public/credit/[account]/messages/route";
import { signCreCallback, verifyCreSignature } from "@/server/credit/callback-signature";
import { linkMessage, underwriteConsentMessage } from "@/server/credit/messages";
import { configureExplainForTests, reportFromForwarderCall } from "@/server/credit/explain";
import { boostAtFaceValue, configureUnderwritingForTests, runUnderwritingQueue, unavailableMessage } from "@/server/credit/underwriting";
import { getDb } from "@/server/db";

import { json, params, request, setupServer, type TestEnv } from "./helpers/env";

/**
 * The product fires the CRE underwriting workflow: the account signs its
 * consent (and a history wallet its link proof), the API verifies both,
 * queues the run and sends it to the workflow's HTTP trigger at most once per
 * 30 s; the workflow's signed callback records the decision, which the app
 * reads with the line from ScoreManager.
 */

let env: TestEnv;
const TRIGGER = "http://127.0.0.1:3534/trigger";
const SECRET = "cre-callback-test-secret";
let triggered: Array<{ url: string; body: unknown }>;
let triggerStatus: number;

function profile(over: Partial<{ underwritten: boolean; declined: boolean; score: number }> = {}) {
  return { score: 0, onTimePayments: 0, latePayments: 0, liquidations: 0, firstSeenAt: 0n, initialized: false, declined: false, underwritten: false, ...over };
}

beforeEach(() => {
  env = setupServer({ CRE_UNDERWRITING_TRIGGER_URL: TRIGGER, POLARIS_CRE_CALLBACK_SECRET: SECRET });
  env.chain.reads.profileOf = () => profile();
  env.chain.reads.requireUnderwriting = () => true;
  env.chain.reads.creditLimitOf = () => 0n;
  triggered = [];
  triggerStatus = 200;
  configureUnderwritingForTests({
    fetch: (async (url: string, init: RequestInit) => {
      triggered.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(triggerStatus === 200 ? "" : "busy", { status: triggerStatus });
    }) as typeof fetch,
  });
});

afterEach(() => {
  configureUnderwritingForTests({ fetch: null });
  configureExplainForTests({ fetch: null });
});

const messages = async (account: string, wallet?: string) =>
  (await json(await messagesGet(request("GET", `/api/public/credit/${account}/messages${wallet ? `?wallet=${wallet}` : ""}`), params({ account })))).body.data;
const underwrite = (body: unknown, ip = "127.0.0.1") => underwritePost(request("POST", "/api/credit/underwrite", { body, headers: { "x-forwarded-for": ip } }), params({}));
const status = async (account: string) => (await json(await creditGet(request("GET", `/api/public/credit/${account}`), params({ account })))).body.data;

async function signedRequest(opts: { withHistory?: boolean } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const history = privateKeyToAccount(generatePrivateKey());
  const m = await messages(account.address, opts.withHistory ? history.address : undefined);
  const consent = { issuedAt: m.issuedAt, nonce: m.nonce, signature: await account.signMessage({ message: m.consent }) };
  const linked = opts.withHistory ? { wallet: history.address, issuedAt: m.issuedAt, nonce: m.nonce, signature: await history.signMessage({ message: m.link }) } : null;
  return { account, history, body: { account: account.address, consent, ...(linked ? { linked } : {}) } };
}

describe("the texts the account and the history wallet sign", () => {
  it("are byte-for-byte the CRE workflow's consent and the underwriting package's link proof", () => {
    const account = "0x1111111111111111111111111111111111111111";
    const wallet = "0x2222222222222222222222222222222222222222";
    // Copied from workflows/src/underwriting/consent.ts and packages/underwriting/src/core/link.ts: keep in step.
    expect(underwriteConsentMessage({ account, wallet, chainId: 10143, issuedAt: 1_790_000_000, nonce: "k3J9abcdEF" })).toBe(
      [
        "Polaris: underwrite this account for Pay in 4 credit, once, from the evidence below.",
        "",
        "Account: 0x1111111111111111111111111111111111111111",
        "History wallet: 0x2222222222222222222222222222222222222222",
        "Chain: 10143",
        "Issued: 2026-09-21T14:13:20Z",
        "Nonce: k3J9abcdEF",
      ].join("\n"),
    );
    expect(underwriteConsentMessage({ account, wallet: null, chainId: 10143, issuedAt: 1_790_000_000, nonce: "k3J9abcdEF" })).toContain("History wallet: none");
    expect(linkMessage({ account, wallet, issuedAt: 1_790_000_000, nonce: "k3J9abcdEF" })).toBe(
      [
        "Polaris: count this wallet's history toward my credit line.",
        "",
        "Account: 0x1111111111111111111111111111111111111111",
        "Wallet: 0x2222222222222222222222222222222222222222",
        "Issued: 2026-09-21T14:13:20Z",
        "Nonce: k3J9abcdEF",
      ].join("\n"),
    );
  });

  it("come from the API with a fresh nonce, on this chain", async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const a = await messages(account);
    const b = await messages(account);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.consent).toContain("Chain: 31337");
    expect(a.link).toBeNull();
  });
});

describe("POST /api/credit/underwrite", () => {
  it("queues a run for an account that signed its consent, and sends { input } to the CRE trigger", async () => {
    const { account, history, body } = await signedRequest({ withHistory: true });
    const res = await json(await underwrite(body));
    expect(res.status).toBe(202);
    expect(res.body.data.request).toMatchObject({ state: "queued", wallet: history.address });

    expect(await runUnderwritingQueue()).toMatchObject({ sent: 1 });
    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.url).toBe(TRIGGER);
    expect(triggered[0]?.body).toEqual({
      input: { user: account.address, consent: body.consent, linked: { ...body.linked, wallet: history.address } },
    });
    expect((await status(account.address)).request).toMatchObject({ state: "sent" });
  });

  it("sends at most one run per CRE_TRIGGER_MIN_INTERVAL_MS, oldest first", async () => {
    const first = await signedRequest();
    const second = await signedRequest();
    await underwrite(first.body);
    await underwrite(second.body, "127.0.0.2");
    const t0 = Date.now();
    expect(await runUnderwritingQueue(t0)).toMatchObject({ sent: 1, waiting: 1 });
    expect(await runUnderwritingQueue(t0 + 10_000)).toMatchObject({ sent: 0, waiting: 1 });
    expect(await runUnderwritingQueue(t0 + 30_001)).toMatchObject({ sent: 1, waiting: 0 });
    expect(triggered.map((t) => (t.body as { input: { user: string } }).input.user)).toEqual([first.account.address, second.account.address]);
  });

  it("refuses a consent someone else signed, a stale one, and a link the wallet didn't sign, queueing nothing", async () => {
    const { body } = await signedRequest({ withHistory: true });
    const stranger = privateKeyToAccount(generatePrivateKey());
    const forged = { ...body, consent: { ...body.consent, signature: await stranger.signMessage({ message: "anything" }) } };
    expect((await json(await underwrite(forged))).body.error).toMatchObject({ code: "invalid_signature", param: "consent.signature" });
    const badLink = { ...body, linked: { ...body.linked!, signature: await stranger.signMessage({ message: "anything" }) } };
    expect((await json(await underwrite(badLink))).body.error).toMatchObject({ code: "invalid_signature", param: "linked.signature" });
    const old = { ...body, consent: { ...body.consent, issuedAt: body.consent.issuedAt - 3600 } };
    expect((await json(await underwrite(old))).body.error.code).toBe("signature_expired");
    expect(await getDb().underwritingRequests.count()).toBe(0);
  });

  it("answers the same request while one is pending, and refuses an account already underwritten", async () => {
    const { body } = await signedRequest();
    const first = await json(await underwrite(body));
    const again = await json(await underwrite(body));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ duplicate: true, request: { id: first.body.data.request.id } });
    expect(await getDb().underwritingRequests.count()).toBe(1);

    env.chain.reads.profileOf = () => profile({ underwritten: true, score: 610 });
    const other = await signedRequest();
    expect((await json(await underwrite(other.body))).body.error.code).toBe("already_underwritten");
  });

  it("says so when no CRE trigger is configured", async () => {
    env = setupServer();
    const { body } = await signedRequest();
    expect((await json(await underwrite(body))).body.error.code).toBe("underwriting_unavailable");
  });

  it("retries a trigger that refuses, then gives up", async () => {
    const { account, body } = await signedRequest();
    await underwrite(body);
    triggerStatus = 503;
    let t = Date.now();
    for (let i = 0; i < 3; i++) {
      await runUnderwritingQueue(t);
      t += 30_001;
    }
    expect(triggered).toHaveLength(3);
    expect((await status(account.address)).request).toMatchObject({ state: "failed", error: expect.stringMatching(/503/) });
  });
});

describe("whether Boost counts at face value (ScoreManager's secured-only rule)", () => {
  it("mirrors _securedOnly: declined, or not underwritten while underwriting is required", () => {
    // declined → face value, whatever else holds
    expect(boostAtFaceValue({ declined: true, underwritten: true }, true)).toBe(true);
    expect(boostAtFaceValue({ declined: true, underwritten: true }, false)).toBe(true);
    expect(boostAtFaceValue({ declined: true, underwritten: false }, false)).toBe(true);
    // requireUnderwriting && !underwritten → face value
    expect(boostAtFaceValue({ declined: false, underwritten: false }, true)).toBe(true);
    // otherwise the multiplier
    expect(boostAtFaceValue({ declined: false, underwritten: true }, true)).toBe(false);
    expect(boostAtFaceValue({ declined: false, underwritten: false }, false)).toBe(false);
    expect(boostAtFaceValue({ declined: false, underwritten: true }, false)).toBe(false);
  });

  it("GET /api/public/credit/{account} reads it from profileOf and requireUnderwriting on chain", async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    // A new account while underwriting is required: secured only.
    expect((await status(account)).onChain).toMatchObject({ underwritten: false, declined: false, boostAtFaceValue: true });

    env.chain.reads.profileOf = () => profile({ underwritten: true, score: 640 });
    expect((await status(account)).onChain).toMatchObject({ boostAtFaceValue: false });

    env.chain.reads.profileOf = () => profile({ underwritten: true, declined: true, score: 640 });
    expect((await status(account)).onChain).toMatchObject({ boostAtFaceValue: true });

    env.chain.reads.profileOf = () => profile();
    env.chain.reads.requireUnderwriting = () => false;
    expect((await status(account)).onChain).toMatchObject({ boostAtFaceValue: false });
  });

  it("claims nothing when the chain can't be read", async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    env.chain.reads.requireUnderwriting = () => {
      throw new Error("rpc down");
    };
    expect((await status(account)).onChain).toBeNull();
  });
});

describe("POST /api/cre/callback", () => {
  const post = (payload: unknown, opts: { secret?: string; at?: number } = {}) => {
    const body = JSON.stringify(payload);
    const header = signCreCallback(opts.secret ?? SECRET, body, opts.at ?? Math.floor(Date.now() / 1000));
    return crePost(new Request("http://localhost:3100/api/cre/callback", { method: "POST", headers: { "content-type": "application/json", "polaris-signature": header, "x-forwarded-for": "127.0.0.1" }, body }), params({}));
  };

  it("records the workflow's decision, closes the request, and the app reads it with the line on chain", async () => {
    const { account, body } = await signedRequest();
    await underwrite(body);
    await runUnderwritingQueue();
    const txHash = `0x${"ab".repeat(32)}`;
    const res = await json(await post({ id: txHash, type: "credit.underwritten", createdAt: 1, chain: "local", user: account.address, linkedWallet: null, score: 640, reason: null, txHash }));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: "credit.underwritten", duplicate: false });

    env.chain.reads.profileOf = () => profile({ underwritten: true, score: 640, initialized: true } as never);
    env.chain.reads.creditLimitOf = () => 350_000_000n;
    const s = await status(account.address);
    expect(s.decision).toMatchObject({ status: "applied", score: 640, txHash });
    expect(s.request).toMatchObject({ state: "done" });
    expect(s.onChain).toMatchObject({ underwritten: true, score: 640, creditLimit: "350.00", boostAtFaceValue: false });

    // Every DON node may deliver it: the second is acknowledged, not applied twice.
    expect((await json(await post({ id: txHash, type: "credit.underwritten", user: account.address, score: 640 }))).body.data.duplicate).toBe(true);
  });

  it("records a thin file (no report) with its reason", async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    await post({ id: `thin:${account.toLowerCase()}:abcdefgh`, type: "credit.thin", user: account, score: null, reason: "no history yet", txHash: null });
    expect((await status(account)).decision).toMatchObject({ status: "thin", reason: "no history yet", txHash: null });
  });

  it("a review that needs a provider with no key fails the request with the provider and its key, and decides nothing", async () => {
    const { account, body } = await signedRequest({ withHistory: true });
    await underwrite(body);
    await runUnderwritingQueue();
    const res = await post({
      id: `unavailable:${account.address.toLowerCase()}:abcdefgh`,
      type: "credit.unavailable",
      user: account.address,
      score: null,
      reason: "not configured: nansen (NANSEN_API_KEY); absent: linked.funder",
      txHash: null,
      notConfigured: [{ provider: "nansen", env: "NANSEN_API_KEY" }],
    });
    expect(res.status).toBe(200);
    const s = await status(account.address);
    expect(s.decision).toBeNull();
    expect(s.request).toMatchObject({
      state: "failed",
      error: "This review needs Nansen, which isn't set up on this server yet (NANSEN_API_KEY). Pay now still works.",
    });
    expect(unavailableMessage(["zerion", "etherscan", "nansen", "bogus"])).toBe(
      "This review needs Zerion, Etherscan and Nansen, which aren't set up on this server yet (ZERION_API_KEY, ETHERSCAN_API_KEY and NANSEN_API_KEY). Pay now still works.",
    );
    expect(unavailableMessage([])).toBe("Credit reviews aren't fully set up on this server yet. Pay now still works.");
  });

  it("refuses a wrong secret, a stale timestamp and a missing header", async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const payload = { id: "x1", type: "credit.refused", user: account };
    expect((await post(payload, { secret: "wrong" })).status).toBe(401);
    expect((await post(payload, { at: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    const bare = await crePost(new Request("http://localhost:3100/api/cre/callback", { method: "POST", headers: { "x-forwarded-for": "127.0.0.1" }, body: JSON.stringify(payload) }), params({}));
    expect(bare.status).toBe(401);
    expect(await getDb().creditDecisions.count()).toBe(0);
  });

  it("is closed without POLARIS_CRE_CALLBACK_SECRET", async () => {
    setupServer();
    expect((await post({ id: "x2", type: "collections.run" })).status).toBe(503);
  });

  it("acknowledges collections runs and unknown types", async () => {
    expect((await post({ id: `0x${"cd".repeat(32)}`, type: "collections.run", tally: { tasks: 1, executed: 1, skipped: 0 }, events: [] })).status).toBe(200);
    expect((await post({ id: "future-1", type: "something.new" })).status).toBe(200);
  });

  it("hears a collections runner's heartbeat, idle runs too, for the dashboard's Collections card", async () => {
    expect(await getDb().collectorRuns.get("cre")).toBeNull();
    expect((await post({ id: "heartbeat-1", type: "collections.heartbeat", status: "idle", checked: 0, tasks: 0, executed: 0, skipped: 0, txHash: null })).status).toBe(200);
    const run = await getDb().collectorRuns.get("cre");
    expect(run?.lastRunAt).toEqual(expect.any(String));
    expect(Date.now() - Date.parse(run!.lastRunAt!)).toBeLessThan(5_000);
  });

  it("verifies exactly the workflows' signing scheme (t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>)", () => {
    const header = signCreCallback("s3cret", '{"id":"1"}', 1_790_000_000);
    // HMAC-SHA256("s3cret", '1790000000.{"id":"1"}'), computed independently.
    expect(header).toBe("t=1790000000,v1=f192598aa9e2545b3fc47aae778a5d16611bc08687a22d1575226dfece7f4501");
    expect(verifyCreSignature("s3cret", '{"id":"1"}', header, 1_790_000_100)).toEqual({ ok: true, timestamp: 1_790_000_000 });
    expect(verifyCreSignature("s3cret", '{"id":"2"}', header, 1_790_000_100)).toMatchObject({ ok: false });
  });
});

describe("the buyer's reasons come from what the DON attested (Nansen and friends), via the gateway", () => {
  const FORWARDER = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);
  const body = `0x${"02".padStart(64, "0")}${"ab".repeat(64)}` as Hex; // any report body: the gateway decodes it
  const forwarderCall = (report: Hex) =>
    encodeFunctionData({ abi: FORWARDER, functionName: "report", args: ["0x3333333333333333333333333333333333333333", concat([`0x${"00".repeat(109)}`, report]), "0x", []] });

  it("cuts the forwarder's 109-byte metadata off the raw report", () => {
    expect(reportFromForwarderCall(forwarderCall(body))).toBe(body);
    expect(reportFromForwarderCall("0x12345678")).toBeNull();
  });

  it("explains an applied decision once, from the report in its transaction, with each line's provider", async () => {
    env = setupServer({ CRE_UNDERWRITING_TRIGGER_URL: TRIGGER, POLARIS_CRE_CALLBACK_SECRET: SECRET, UNDERWRITING_GATEWAY_URL: "http://127.0.0.1:3535/", UNDERWRITING_API_TOKEN: "gw-token" });
    env.chain.reads.profileOf = () => profile({ underwritten: true, score: 640 });
    env.chain.reads.creditLimitOf = () => 350_000_000n;
    env.chain.reads.activeDebtOf = () => 0n;
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const txHash = `0x${"ef".repeat(32)}` as Hex;
    env.chain.transactions.set(txHash, { input: forwarderCall(body) });

    const asked: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    configureExplainForTests({
      fetch: (async (url: string, init: RequestInit) => {
        asked.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
        return Response.json({
          kind: 2,
          items: [
            {
              user: account,
              decision: {
                score: 640,
                limit: "350000000",
                reasons: [
                  { text: "You've used this account for 2 years · +48", points: 48, kind: "plus", provider: "nansen" },
                  { text: "Funded from a major exchange · +10", points: 10, kind: "plus", provider: "nansen" },
                ],
              },
            },
          ],
        });
      }) as typeof fetch,
    });

    const body2 = JSON.stringify({ id: txHash, type: "credit.underwritten", user: account, score: 640, txHash });
    await crePost(new Request("http://localhost:3100/api/cre/callback", { method: "POST", headers: { "polaris-signature": signCreCallback(SECRET, body2, Math.floor(Date.now() / 1000)), "x-forwarded-for": "127.0.0.1" }, body: body2 }), params({}));
    const s = await status(account);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ url: "http://127.0.0.1:3535/v1/explain", auth: "Bearer gw-token", body: { report: body, activeDebt: "0" } });
    expect(s.decision.explanation).toMatchObject({ score: 640, limitUnits: "350000000", source: "gateway" });
    expect(s.decision.explanation.reasons.map((r: { provider: string }) => r.provider)).toEqual(["nansen", "nansen"]);
    // Explained once, then kept.
    await status(account);
    expect(asked).toHaveLength(1);
  });

  it("shows the decision without reasons when there is no gateway", async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const txHash = `0x${"aa".repeat(32)}` as Hex;
    const raw = JSON.stringify({ id: txHash, type: "credit.underwritten", user: account, score: 600, txHash });
    await crePost(new Request("http://localhost:3100/api/cre/callback", { method: "POST", headers: { "polaris-signature": signCreCallback(SECRET, raw, Math.floor(Date.now() / 1000)), "x-forwarded-for": "127.0.0.1" }, body: raw }), params({}));
    expect((await status(account)).decision).toMatchObject({ status: "applied", explanation: null });
  });
});
