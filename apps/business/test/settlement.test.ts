import { encodeErrorResult, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { polarisCheckoutAbi, polarisPaymentsAbi } from "@polarispay/contracts/abi";
import { POST as openLinkRoute } from "@/app/api/public/links/[id]/checkout/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { GET as retrieveRoute } from "@/app/api/v1/checkout/sessions/[id]/route";
import { POST as sdkRelay } from "@/app/api/v1/relay/payments/route";
import { getDb } from "@/server/db";
import { syncChain } from "@/server/ingest/sync";
import { checkRelayerCall } from "@/server/policy/relayer";
import { relayerAddresses } from "@/server/relayer/submit";
import { requireChain } from "@/server/chain/client";

import { makeLog, type LogSpec } from "./helpers/fake-chain";
import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { emitLikeTheContracts, merchantWithKeys, newSession, orderKey, signPayNow, type Merchant } from "./helpers/flows";

/**
 * A checkout session is paid only by what it asked for. The order id is
 * public (the session id, or the hosted checkout's view), so anyone can
 * settle the session's order on chain some other way: 1 micro-AUSD straight
 * to PolarisPayments, a smaller Pay in 4, a cheaper plan. None of that may
 * complete the session, count on its link, or send the webhook a merchant
 * fulfils on. And the price is pinned on chain before the order id is out.
 */

let env: TestEnv;
let merchant: Merchant;
const buyer = privateKeyToAccount(generatePrivateKey());

beforeEach(async () => {
  env = setupServer();
  emitLikeTheContracts(env);
  merchant = await merchantWithKeys({ webhook: true });
});

function chainEmits(specs: LogSpec[]): Hex {
  env.chain.blockNumber += 1n;
  const txHash = `0x${env.chain.blockNumber.toString(16).padStart(64, "0")}` as Hex;
  env.chain.logs.push(...specs.map((s, i) => makeLog(s, { txHash, logIndex: i, blockNumber: env.chain.blockNumber })));
  return txHash;
}

const retrieve = async (id: string) =>
  (await json(await retrieveRoute(request("GET", `/api/v1/checkout/sessions/${id}`, { headers: { authorization: `Bearer ${merchant.secret}` } }), params({ id })))).body.data;

const eventTypes = async () => (await getDb().webhookEvents.find({})).map((e) => e.type);

describe("the session's price is pinned on chain before the session is handed out", () => {
  it("sends PolarisPayments.quoteOrder(merchant, orderKey, amount) as the relayer, on the relayer's allow-list", async () => {
    const session = await newSession(merchant);
    const key = orderKey(merchant.account.address, session.orderId);
    expect(env.chain.quotes).toEqual([{ merchant: merchant.account.address, orderKey: key, amount: 200_000_000n }]);
    const [quoteTx] = env.chain.sent;
    expect(quoteTx?.to).toBe(ADDR.payments);
    expect(checkRelayerCall({ to: quoteTx?.to, data: quoteTx?.data, chainId: 31337 }, { chainId: 31337, addresses: relayerAddresses(requireChain()) }).functionName).toBe("quoteOrder");
    const stored = await getDb().sessions.get(session.id);
    expect(stored?.chain.quote).toMatchObject({ amountUnits: "200000000", txHash: quoteTx?.hash });
    // A quote is the operator's, not the session's settlement: it never blocks the buyer's payment.
    expect((await getDb().relays.find({})).every((r) => r.sessionId === null)).toBe(true);
  });

  it("refuses the session when its order is already paid on chain, and creates nothing", async () => {
    env.chain.reverts.set("quoteOrder", encodeErrorResult({ abi: polarisPaymentsAbi, errorName: "DuplicatePayment" }));
    await expect(newSession(merchant, { orderId: "INV-taken" })).rejects.toThrow(/order_already_paid/);
    expect(await getDb().sessions.count()).toBe(0);
  });

  it("creates no session whose price couldn't be pinned", async () => {
    env.chain.reverts.set("quoteOrder", encodeErrorResult({ abi: polarisPaymentsAbi, errorName: "NotOperator" }));
    await expect(newSession(merchant)).rejects.toThrow(/price_not_pinned/);
    expect(await getDb().sessions.count()).toBe(0);
  });

  it("pins a payment link session's price when it is paid, not when anyone opens it, and bounds how fast one link can be opened", async () => {
    await getDb().links.insert({
      id: "pl_ratelimited01",
      merchantId: merchant.userId,
      url: "http://localhost:3000/pay/pl_ratelimited01",
      amountCents: 1500,
      description: "Poster",
      modes: ["now"],
      usage: "reusable",
      expiresAt: null,
      status: "active",
      paymentsCount: 0,
      collectedCents: 0,
      createdAt: new Date().toISOString(),
    });
    const open = () => openLinkRoute(request("POST", "/api/public/links/pl_ratelimited01/checkout"), params({ id: "pl_ratelimited01" }));
    const opened = await json(await open());
    expect(opened.status).toBe(201);
    // Opening a public link costs the relayer nothing: no transaction until someone pays.
    expect(env.chain.sent).toHaveLength(0);

    // A verified payment pins the price first, then pays.
    const pub = opened.body.data;
    const auth = await signPayNow(buyer, merchant.account.address, pub.chain.orderId, 15_000_000n);
    const paid = await json(await relayRoute(request("POST", "/api/relay", { body: { type: "pay", sessionId: pub.id, buyer: buyer.address, ...auth } }), params({})));
    expect(paid.status).toBe(200);
    expect(env.chain.sent.map((t) => t.functionName)).toEqual(["quoteOrder", "pay"]);
    expect(env.chain.quotes[0]).toMatchObject({ orderKey: pub.chain.orderKey, amount: 15_000_000n });
    expect((await getDb().sessions.get(pub.id))?.chain.quote).toMatchObject({ amountUnits: "15000000" });

    // A junk signature never gets as far as the quote.
    const other = (await json(await open())).body.data;
    const junk = { ...(await signPayNow(buyer, merchant.account.address, other.chain.orderId, 15_000_000n)), signature: `0x${"11".repeat(65)}` };
    expect((await relayRoute(request("POST", "/api/relay", { body: { type: "pay", sessionId: other.id, buyer: buyer.address, ...junk } }), params({}))).status).toBe(400);
    expect(env.chain.quotes).toHaveLength(1);

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await open()).status);
    expect(statuses).toContain(429);
  });
});

describe("a settlement that doesn't match the session never completes it", () => {
  it("1 micro-AUSD paid straight to PolarisPayments for a $200 session: still unpaid, no payment.succeeded, can't be relayed", async () => {
    await syncChain();
    const session = await newSession(merchant);
    const key = orderKey(merchant.account.address, session.orderId);
    const tx = chainEmits([
      { address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "PaymentMade", args: { paymentId: key, payer: buyer.address, merchant: merchant.account.address, amount: 1n, fee: 0n, orderId: session.orderId } },
    ]);
    await syncChain();

    const read = await retrieve(session.id);
    expect(read).toMatchObject({ status: "open", paymentStatus: "unpaid", amount: "200.00", payment: null });
    expect(await eventTypes()).not.toContain("payment.succeeded");
    const stored = await getDb().sessions.get(session.id);
    expect(stored?.mismatches).toEqual([
      expect.objectContaining({ mode: "now", payer: buyer.address, txHash: tx, expectedUnits: "200000000", gotUnits: "1" }),
    ]);
    // The money is the merchant's either way, and the dashboard shows it for what it is.
    expect(await getDb().payments.get(key)).toMatchObject({ amountUnits: "1", mismatch: expect.stringContaining("0.000001") });

    const auth = await signPayNow(buyer, merchant.account.address, session.orderId, 200_000_000n);
    const relayed = await json(await relayRoute(request("POST", "/api/relay", { body: { type: "pay", sessionId: session.id, buyer: buyer.address, ...auth } }), params({})));
    expect(relayed.status).toBe(409);
    expect(relayed.body.error.code).toBe("order_settled_elsewhere");
  });

  it("the full price paid straight from a wallet does complete it", async () => {
    await syncChain();
    const session = await newSession(merchant);
    const key = orderKey(merchant.account.address, session.orderId);
    chainEmits([
      { address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "PaymentMade", args: { paymentId: key, payer: buyer.address, merchant: merchant.account.address, amount: 200_000_000n, fee: 1_000_000n, orderId: session.orderId } },
    ]);
    await syncChain();
    expect(await retrieve(session.id)).toMatchObject({ status: "complete", paymentStatus: "paid" });
    expect(await eventTypes()).toContain("payment.succeeded");
  });

  it("a smaller Pay in 4 principal on the session's order", async () => {
    await syncChain();
    const session = await newSession(merchant);
    const key = orderKey(merchant.account.address, session.orderId);
    chainEmits([
      {
        address: ADDR.checkout,
        abi: polarisCheckoutAbi as never,
        eventName: "PlanOpened",
        args: { orderKey: key, merchant: merchant.account.address, buyer: buyer.address, loanId: 5n, orderId: session.orderId, principal: 20_000_000n, totalOwed: 20_153_424n, installments: 4, interval: 604_800n, firstDueAt: env.chain.timestamp + 604_800n },
      },
    ]);
    await syncChain();
    expect(await retrieve(session.id)).toMatchObject({ status: "open", paymentStatus: "unpaid" });
    expect(await eventTypes()).not.toContain("plan.opened");
    expect((await getDb().sessions.get(session.id))?.mismatches?.[0]).toMatchObject({ mode: "later", gotUnits: "20000000" });
    expect((await getDb().plans.get("5"))?.sessionId).toBeNull();
  });

  it("a mode the session doesn't offer", async () => {
    await syncChain();
    const session = await newSession(merchant, { modes: ["now"] });
    const key = orderKey(merchant.account.address, session.orderId);
    chainEmits([
      {
        address: ADDR.checkout,
        abi: polarisCheckoutAbi as never,
        eventName: "PlanOpened",
        args: { orderKey: key, merchant: merchant.account.address, buyer: buyer.address, loanId: 6n, orderId: session.orderId, principal: 200_000_000n, totalOwed: 201_534_246n, installments: 4, interval: 604_800n, firstDueAt: env.chain.timestamp + 604_800n },
      },
    ]);
    await syncChain();
    expect(await retrieve(session.id)).toMatchObject({ status: "open" });
    expect((await getDb().sessions.get(session.id))?.mismatches?.[0]?.reason).toMatch(/doesn't offer Pay in 4/);
  });

  it("a cheaper plan of the same merchant subscribed on the session's order", async () => {
    await syncChain();
    const session = await newSession(merchant, { amount: "9.99", modes: ["subscribe"], subscription: { interval: "month" } });
    const { ensureSubscriptionPlan } = await import("@/server/sessions/sessions");
    await ensureSubscriptionPlan((await getDb().sessions.get(session.id))!);
    const key = orderKey(merchant.account.address, session.orderId);
    chainEmits([
      {
        address: ADDR.checkout,
        abi: polarisCheckoutAbi as never,
        eventName: "SubscriptionStarted",
        args: { orderKey: key, merchant: merchant.account.address, buyer: buyer.address, subId: 3n, planId: 8n, orderId: session.orderId, pricePerPeriod: 990_000n, periodSeconds: 2_592_000n, nextChargeAt: env.chain.timestamp + 2_592_000n },
      },
    ]);
    await syncChain();
    expect(await retrieve(session.id)).toMatchObject({ status: "open", paymentStatus: "unpaid" });
    expect((await getDb().sessions.get(session.id))?.mismatches?.[0]).toMatchObject({ mode: "subscribe", gotUnits: "990000" });
    expect((await getDb().subscriptions.get("3"))?.sessionId).toBeNull();
  });

  it("the same price on another plan (another period) of the same merchant", async () => {
    await syncChain();
    const session = await newSession(merchant, { amount: "9.99", modes: ["subscribe"], subscription: { interval: "month" } });
    const { ensureSubscriptionPlan } = await import("@/server/sessions/sessions");
    await ensureSubscriptionPlan((await getDb().sessions.get(session.id))!);
    const key = orderKey(merchant.account.address, session.orderId);
    chainEmits([
      {
        address: ADDR.checkout,
        abi: polarisCheckoutAbi as never,
        eventName: "SubscriptionStarted",
        args: { orderKey: key, merchant: merchant.account.address, buyer: buyer.address, subId: 4n, planId: 9n, orderId: session.orderId, pricePerPeriod: 9_990_000n, periodSeconds: 86_400n, nextChargeAt: env.chain.timestamp + 86_400n },
      },
    ]);
    await syncChain();
    expect(await retrieve(session.id)).toMatchObject({ status: "open" });
    expect((await getDb().sessions.get(session.id))?.mismatches?.[0]?.reason).toMatch(/plan 9/);
  });

  it("an underpaid single-use payment link stays unused", async () => {
    await syncChain();
    await getDb().links.insert({
      id: "pl_singleuse0001",
      merchantId: merchant.userId,
      url: "http://localhost:3000/pay/pl_singleuse0001",
      amountCents: 5000,
      description: "Consultation",
      modes: ["now"],
      usage: "single",
      expiresAt: null,
      status: "active",
      paymentsCount: 0,
      collectedCents: 0,
      createdAt: new Date().toISOString(),
    });
    const opened = await json(await openLinkRoute(request("POST", "/api/public/links/pl_singleuse0001/checkout"), params({ id: "pl_singleuse0001" })));
    const pub = opened.body.data;
    // A dashboard link has no merchant page: the buyer finishes in the Polaris app, not on /pay/{id} again.
    expect(pub.successUrl).toBe("http://localhost:3000/");
    chainEmits([
      {
        address: ADDR.payments,
        abi: polarisPaymentsAbi as never,
        eventName: "PaymentMade",
        args: { paymentId: pub.chain.orderKey, payer: buyer.address, merchant: merchant.account.address, amount: 1n, fee: 0n, orderId: pub.chain.orderId },
      },
    ]);
    await syncChain();
    expect(await getDb().links.get("pl_singleuse0001")).toMatchObject({ status: "active", paymentsCount: 0, collectedCents: 0 });
  });
});

describe("polarispay-sdk's direct pay can't settle a checkout's order", () => {
  const sdkBody = async (orderId: string, amount: bigint) => {
    const auth = await signPayNow(buyer, merchant.account.address, orderId, amount);
    return {
      type: "payWithAuthorization",
      chainId: 31337,
      contract: ADDR.payments,
      payer: buyer.address,
      merchant: merchant.account.address,
      amount: amount.toString(),
      orderId,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: orderKey(merchant.account.address, orderId),
      signature: auth.signature,
    };
  };
  const post = (body: unknown) =>
    sdkRelay(request("POST", "/api/v1/relay/payments", { body, headers: { authorization: `Bearer ${merchant.publishableKey}`, origin: "https://shop.example" } }), params({}));

  it("refuses a session's order id (the reported attack: $200 session, 1 base unit, relayed for free)", async () => {
    const session = await newSession(merchant);
    const res = await post(await sdkBody(session.orderId, 1n));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("order_is_a_checkout");
    expect(env.chain.relayed).toHaveLength(0);
    expect(await retrieve(session.id)).toMatchObject({ status: "open", paymentStatus: "unpaid" });
  });

  it("refuses an order PolarisCheckout already settled as Pay in 4 or a subscription", async () => {
    env.chain.reads.orders = () => [2, 1n, buyer.address as Address, 25_000_000n, 1n];
    const res = await post(await sdkBody("shop-order-1", 25_000_000n));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("already_paid");
    expect(env.chain.relayed).toHaveLength(0);
  });
});
