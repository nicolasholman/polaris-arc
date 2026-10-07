import { encodeErrorResult, encodeFunctionData, getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { polarisCheckoutAbi, polarisLoanEngineAbi } from "@polarispay/contracts/abi";
import { POST as relayRoute, OPTIONS as relayPreflight } from "@/app/api/relay/route";
import { POST as sdkRelay } from "@/app/api/v1/relay/payments/route";
import { getDb } from "@/server/db";
import { PolicyViolation } from "@/server/policy/relayer";
import { getRelayerAccount } from "@/server/relayer/signer";
import { submitCall } from "@/server/relayer/submit";
import { TYPES } from "@/server/relayer/typed-data";
import { dispatchDue } from "@/server/webhooks/dispatcher";

import { verifyWebhook } from "../../../packages/sdk/src/server/webhooks";
import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { checkoutDomain, emitLikeTheContracts, inSeconds, merchantWithKeys, newSession, orderKey, signPayNow, stablecoinDomain, type Merchant } from "./helpers/flows";

let env: TestEnv;
let merchant: Merchant;
const buyer = privateKeyToAccount(generatePrivateKey());

beforeEach(async () => {
  env = setupServer();
  emitLikeTheContracts(env);
  merchant = await merchantWithKeys({ webhook: true });
});

const relay = (body: unknown, headers: Record<string, string> = {}) => relayRoute(request("POST", "/api/relay", { body, headers }), params({}));

async function payNowBody(session: Record<string, any>, signer = buyer) {
  const auth = await signPayNow(signer, merchant.account.address, session.orderId ?? session.id, 200_000_000n);
  return { type: "pay", sessionId: session.id, buyer: buyer.address, ...auth };
}

describe("POST /api/relay type=pay (Pay now)", () => {
  it("verifies the buyer's signature, relays PolarisCheckout.pay with estimate + 15% gas, and completes the session from the receipt", async () => {
    const session = await newSession(merchant);
    const res = await json(await relay(await payNowBody(session)));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: "pay", status: "confirmed", sessionId: session.id, paymentId: orderKey(merchant.account.address, session.orderId) });

    const [sent] = env.chain.relayed;
    expect(sent?.to).toBe(ADDR.checkout);
    expect(sent?.chainId).toBe(31337);
    expect(sent?.value).toBe(0n);
    expect(sent?.gas).toBe(230_000n); // 200k estimate + 15%: Monad bills the limit

    const stored = await getDb().sessions.get(session.id);
    expect(stored?.status).toBe("complete");
    expect(stored?.payment).toMatchObject({ mode: "now", payer: buyer.address, txHash: sent?.hash, chainId: 31337, paymentId: orderKey(merchant.account.address, session.orderId), planId: null, subscriptionId: null });
    const payments = await getDb().payments.find({});
    expect(payments[0]).toMatchObject({ kind: "now", amountUnits: "200000000", feeUnits: "1000000", sessionId: session.id });
  });

  it("sends a payment.succeeded webhook the SDK verifies, with the documented fields", async () => {
    const session = await newSession(merchant, { metadata: { cart: "42" } });
    await relay(await payNowBody(session));
    const summary = await dispatchDue();
    expect(summary).toMatchObject({ attempted: 1, succeeded: 1 });
    const delivery = env.deliveries[0];
    expect(delivery?.headers["polaris-event"]).toBe("payment.succeeded");
    const event = verifyWebhook(delivery?.body as string, delivery?.headers["polaris-signature"], merchant.webhookSecret as string);
    expect(event).toMatchObject({ object: "event", type: "payment.succeeded", livemode: false });
    expect(event.merchantId).toMatch(/^mer_/);
    expect(event.data).toEqual({
      orderId: session.orderId,
      sessionId: session.id,
      metadata: { cart: "42" },
      paymentId: orderKey(merchant.account.address, session.orderId),
      mode: "now",
      merchant: merchant.account.address,
      payer: buyer.address,
      amount: "200.00",
      fee: "1.00",
      currency: "USD",
      txHash: env.chain.relayed[0]?.hash,
      chainId: 31337,
    });
  });

  it("is idempotent: the same signature relays once, even after the session is paid", async () => {
    const session = await newSession(merchant);
    const body = await payNowBody(session);
    const first = await json(await relay(body));
    const second = await json(await relay(body));
    expect(second.status).toBe(200);
    expect(second.body.data.txHash).toBe(first.body.data.txHash);
    expect(env.chain.relayed).toHaveLength(1);
  });

  it("refuses a signature from someone else, and one for another amount, before spending gas", async () => {
    const session = await newSession(merchant);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const forged = await json(await relay(await payNowBody(session, stranger)));
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("invalid_signature");
    const cheap = await signPayNow(buyer, merchant.account.address, session.orderId, 1_000_000n);
    const underpaid = await json(await relay({ type: "pay", sessionId: session.id, buyer: buyer.address, ...cheap }));
    expect(underpaid.body.error.code).toBe("invalid_signature");
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("refuses a signature that redirects the payment to another merchant", async () => {
    const session = await newSession(merchant);
    const other = "0x9999999999999999999999999999999999999999" as Address;
    const auth = await signPayNow(buyer, other, session.orderId, 200_000_000n);
    const res = await json(await relay({ type: "pay", sessionId: session.id, buyer: buyer.address, ...auth }));
    expect(res.body.error.code).toBe("invalid_signature");
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("refuses paid, expired and unknown sessions", async () => {
    const session = await newSession(merchant);
    await relay(await payNowBody(session));
    // A fresh signature (not a replay of the first) for a session that is already paid.
    const fresh = await signPayNow(buyer, merchant.account.address, session.orderId, 200_000_000n, inSeconds(1000));
    const again = await json(await relay({ type: "pay", sessionId: session.id, buyer: buyer.address, ...fresh }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_paid");

    const old = await newSession(merchant);
    await getDb().sessions.update(old.id, (s) => ({ ...s, expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect((await json(await relay(await payNowBody(old)))).status).toBe(410);
    const other = await signPayNow(buyer, merchant.account.address, "nothing", 200_000_000n, inSeconds(1100));
    expect((await json(await relay({ type: "pay", sessionId: "cs_test_doesnotexist", buyer: buyer.address, ...other }))).status).toBe(404);
  });

  it("turns a simulated revert into the buyer's message and sends nothing", async () => {
    const session = await newSession(merchant);
    env.chain.reverts.set("pay", encodeErrorResult({ abi: polarisCheckoutAbi, errorName: "OrderAlreadySettled", args: [orderKey(merchant.account.address, session.orderId)] }));
    const res = await json(await relay(await payNowBody(session)));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "already_paid", message: "This has already been paid." });
    expect(env.chain.relayed).toHaveLength(0);
    const record = (await getDb().relays.find({})).find((r) => r.kind === "pay");
    expect(record?.state).toBe("failed");
  });

  it("validates shape: type, addresses, numbers, signatures, expired authorisations", async () => {
    const session = await newSession(merchant);
    expect((await json(await relay({ type: "steal" }))).body.error).toMatchObject({ code: "invalid_request", param: "type" });
    const body = await payNowBody(session);
    expect((await json(await relay({ ...body, buyer: "0x123" }))).body.error.param).toBe("buyer");
    expect((await json(await relay({ ...body, signature: "0x1234" }))).body.error.param).toBe("signature");
    expect((await json(await relay({ ...body, validBefore: "1" }))).body.error.code).toBe("signature_expired");
    expect((await json(await relay({ ...body, chainId: 10143 }))).body.error.code).toBe("wrong_chain");
  });

  it("rate-limits one account's verified requests (junk signatures don't count against the account they name)", async () => {
    const session = await newSession(merchant);
    const junk = { ...(await payNowBody(session)), signature: `0x${"11".repeat(65)}` };
    const junkStatuses: number[] = [];
    for (let i = 0; i < 8; i++) junkStatuses.push((await relay(junk, { "x-forwarded-for": "198.51.100.40" })).status);
    expect(junkStatuses).not.toContain(429);

    env.chain.reverts.set("pay", encodeErrorResult({ abi: polarisCheckoutAbi, errorName: "OrderAlreadySettled", args: [orderKey(merchant.account.address, session.orderId)] }));
    const body = await payNowBody(session);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await relay(body, { "x-forwarded-for": "198.51.100.41" })).status);
    expect(statuses).toContain(429);
  });

  it("answers CORS preflight for the app's origin only", async () => {
    const ok = await relayPreflight(request("OPTIONS", "/api/relay", { headers: { origin: "http://localhost:3000" } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const no = await relayPreflight(request("OPTIONS", "/api/relay", { headers: { origin: "https://evil.example" } }));
    expect(no.status).toBe(403);
  });
});

describe("POST /api/relay type=openPlan (Pay in 4)", () => {
  async function planBody(session: Record<string, any>, over: Partial<{ installments: number; interval: bigint }> = {}) {
    const deadline = BigInt(inSeconds(600));
    const intent = {
      buyer: buyer.address,
      merchant: merchant.account.address,
      principal: 200_000_000n,
      installments: over.installments ?? 4,
      interval: over.interval ?? 604_800n,
      orderId: session.orderId as string,
      nonce: 0n,
      deadline,
    };
    const signature = await buyer.signTypedData({ domain: checkoutDomain, types: TYPES.PlanIntent, primaryType: "PlanIntent", message: intent });
    const permitValue = 201_534_246n;
    const permitDeadline = BigInt(inSeconds(1800));
    const permitSig = await buyer.signTypedData({
      domain: stablecoinDomain,
      types: TYPES.Permit,
      primaryType: "Permit",
      message: { owner: buyer.address, spender: ADDR.loanEngine, value: permitValue, nonce: 0n, deadline: permitDeadline },
    });
    return {
      type: "openPlan",
      sessionId: session.id,
      intent: { buyer: buyer.address, principal: "200000000", installments: String(intent.installments), interval: String(intent.interval), nonce: "0", deadline: String(deadline) },
      signature,
      permit: { value: String(permitValue), deadline: String(permitDeadline), signature: permitSig },
    };
  }

  it("opens the plan through PolarisCheckout.openPlan and sends plan.opened with the schedule", async () => {
    const session = await newSession(merchant);
    const res = await json(await relay(await planBody(session)));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: "openPlan", status: "confirmed", planId: "1" });
    const sent = env.chain.relayed[0];
    expect(sent?.to).toBe(ADDR.checkout);

    const plan = await getDb().plans.get("1");
    expect(plan).toMatchObject({ principalUnits: "200000000", totalOwedUnits: "201534246", installments: 4, state: "collecting", sessionId: session.id });
    expect((await getDb().sessions.get(session.id))?.payment).toMatchObject({ mode: "later", planId: "1" });

    await dispatchDue();
    const event = verifyWebhook(env.deliveries[0]?.body as string, env.deliveries[0]?.headers["polaris-signature"], merchant.webhookSecret as string);
    expect(event.type).toBe("plan.opened");
    expect(event.data).toMatchObject({
      planId: "1",
      mode: "later",
      principal: "200.00",
      interest: "1.534246",
      total: "201.534246",
      installments: 4,
      intervalSeconds: 604800,
      currency: "USD",
      sessionId: session.id,
      orderId: session.orderId,
    });
    expect((event.data as { schedule: Array<{ index: number; amount: string }> }).schedule.map((s) => s.amount)).toEqual(["50.383562", "50.383561", "50.383562", "50.383561"]);
  });

  it("refuses a schedule the checkout doesn't offer, and a mode it doesn't offer", async () => {
    const session = await newSession(merchant);
    const weird = await json(await relay(await planBody(session, { installments: 12 })));
    expect(weird.body.error.code).toBe("invalid_plan");
    const nowOnly = await newSession(merchant, { modes: ["now"] });
    const res = await json(await relay(await planBody(nowOnly)));
    expect(res.body.error.code).toBe("mode_not_offered");
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("refuses a permit signed for another spender", async () => {
    const session = await newSession(merchant);
    const body = await planBody(session);
    const wrong = await buyer.signTypedData({
      domain: stablecoinDomain,
      types: TYPES.Permit,
      primaryType: "Permit",
      message: { owner: buyer.address, spender: ADDR.payments, value: 201_534_246n, nonce: 0n, deadline: BigInt(body.permit.deadline) },
    });
    const res = await json(await relay({ ...body, permit: { ...body.permit, signature: wrong } }));
    expect(res.body.error.code).toBe("invalid_signature");
  });

  it("maps ExceedsCreditLimit to the buyer's message", async () => {
    const session = await newSession(merchant);
    env.chain.reverts.set("openPlan", encodeErrorResult({ abi: polarisLoanEngineAbi, errorName: "ExceedsCreditLimit" }));
    const res = await json(await relay(await planBody(session)));
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("over_limit");
  });

  it("won't carry a second, different signature while the first is in flight", async () => {
    const session = await newSession(merchant);
    await getDb().relays.insert({
      id: "sig:other",
      kind: "pay",
      state: "submitted",
      signer: buyer.address,
      to: ADDR.checkout,
      txHash: `0x${"12".repeat(32)}`,
      blockNumber: null,
      sessionId: session.id,
      merchantId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await json(await relay(await planBody(session)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("payment_in_progress");
  });
});

describe("POST /api/v1/relay/payments (polarispay-sdk pay())", () => {
  async function sdkBody(over: Record<string, unknown> = {}) {
    const orderId = `sdk-${Math.random().toString(36).slice(2, 8)}`;
    const auth = await signPayNow(buyer, merchant.account.address, orderId, 25_000_000n);
    return {
      type: "payWithAuthorization",
      chainId: 31337,
      contract: ADDR.payments,
      payer: buyer.address,
      merchant: merchant.account.address,
      amount: "25000000",
      orderId,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: orderKey(merchant.account.address, orderId),
      signature: auth.signature,
      ...over,
    };
  }
  const post = (body: unknown, key: string | null) =>
    sdkRelay(request("POST", "/api/v1/relay/payments", { body, headers: key ? { authorization: `Bearer ${key}`, origin: "https://shop.example" } : {} }), params({}));

  it("relays PolarisPayments.payWithAuthorization for the key's own merchant", async () => {
    const res = await post(await sdkBody(), merchant.publishableKey);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ status: "confirmed" });
    expect(body.data.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(env.chain.relayed[0]?.to).toBe(ADDR.payments);
    await dispatchDue();
    expect(env.deliveries[0]?.headers["polaris-event"]).toBe("payment.succeeded");
  });

  it("refuses another contract, another chain, another merchant and a wrong nonce", async () => {
    expect((await (await post(await sdkBody({ contract: ADDR.checkout }), merchant.publishableKey)).json()).error.code).toBe("wrong_contract");
    expect((await (await post(await sdkBody({ chainId: 10143 }), merchant.publishableKey)).json()).error.code).toBe("wrong_chain");
    const other = await sdkBody({ merchant: "0x9999999999999999999999999999999999999999" });
    expect((await post(other, merchant.publishableKey)).status).toBe(403);
    expect((await (await post(await sdkBody({ nonce: `0x${"00".repeat(32)}` }), merchant.publishableKey)).json()).error.code).toBe("wrong_nonce");
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("needs a publishable key, and refuses a secret one sent from a browser", async () => {
    expect((await post(await sdkBody(), null)).status).toBe(401);
    const res = await post(await sdkBody(), merchant.secret);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("publishable_key_required");
  });
});

describe("the dev adapter is held to the production policy", () => {
  it("refuses to sign a call off the allow-list, even one the server builds itself", async () => {
    const signer = await getRelayerAccount();
    expect(signer?.kind).toBe("local");
    const data = encodeFunctionData({ abi: polarisLoanEngineAbi, functionName: "withdrawLiquidity", args: [1n, getAddress(buyer.address)] });
    await expect(submitCall({ signer: signer!, role: "relayer", to: ADDR.loanEngine, data, waitMs: 0 })).rejects.toBeInstanceOf(PolicyViolation);
    expect(env.chain.relayed).toHaveLength(0);
  });
});
