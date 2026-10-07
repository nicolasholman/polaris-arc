import { encodeErrorResult, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { collectionsReceiverAbi, polarisLoanEngineAbi, polarisPaymentsAbi } from "@polarispay/contracts/abi";
import { GET as registrationGet, POST as registrationPost } from "@/app/api/merchant/registration/route";
import { POST as meUpdate } from "@/app/api/me/route";
import { POST as withdrawRoute } from "@/app/api/payouts/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { POST as testEvent } from "@/app/api/webhooks/[id]/test/route";
import { GET as listWebhooks } from "@/app/api/webhooks/route";
import { POST as retryRoute } from "@/app/api/webhooks/deliveries/[id]/retry/route";
import { GET as tick } from "@/app/api/cron/tick/route";
import { getDb } from "@/server/db";
import { syncChain } from "@/server/ingest/sync";
import { TYPES } from "@/server/relayer/typed-data";
import { dispatchDue } from "@/server/webhooks/dispatcher";
import { MAX_DELIVERY_ATTEMPTS, verifyWebhookSignature } from "@polaris/db";

import { verifyWebhook } from "../../../packages/sdk/src/server/webhooks";
import { makeLog, type LogSpec } from "./helpers/fake-chain";
import { ADDR, json, params, request, setupServer, signIn, type TestEnv } from "./helpers/env";
import { checkoutDomain, emitLikeTheContracts, inSeconds, merchantWithKeys, newSession, orderKey, stablecoinDomain, type Merchant } from "./helpers/flows";

let env: TestEnv;
let merchant: Merchant;
const buyer = privateKeyToAccount(generatePrivateKey());

beforeEach(async () => {
  env = setupServer();
  emitLikeTheContracts(env);
  merchant = await merchantWithKeys({ webhook: true });
});

/** Put logs on the fake chain as if a transaction nobody here sent (CRE, a wallet) had emitted them. */
function chainEmits(specs: LogSpec[]): Hex {
  env.chain.blockNumber += 1n;
  const txHash = `0x${env.chain.blockNumber.toString(16).padStart(64, "0")}` as Hex;
  env.chain.logs.push(...specs.map((s, i) => makeLog(s, { txHash, logIndex: i, blockNumber: env.chain.blockNumber })));
  return txHash;
}

async function openPlan(): Promise<void> {
  const session = await newSession(merchant);
  const deadline = BigInt(inSeconds(600));
  const intent = { buyer: buyer.address, merchant: merchant.account.address, principal: 200_000_000n, installments: 4, interval: 604_800n, orderId: session.orderId as string, nonce: 0n, deadline };
  const signature = await buyer.signTypedData({ domain: checkoutDomain, types: TYPES.PlanIntent, primaryType: "PlanIntent", message: intent });
  const res = await relayRoute(
    request("POST", "/api/relay", {
      body: { type: "openPlan", sessionId: session.id, intent: { buyer: buyer.address, principal: "200000000", installments: "4", interval: "604800", nonce: "0", deadline: String(deadline) }, signature },
    }),
    params({}),
  );
  expect(res.status).toBe(200);
}

async function eventsOfType(type: string) {
  return (await getDb().webhookEvents.find({})).filter((e) => e.type === type).map((e) => JSON.parse(e.body) as { data: Record<string, unknown> });
}

describe("chain events nobody here sent arrive through the chain sync", () => {
  it("installment.collected, then plan.completed, from the loan engine", async () => {
    await syncChain(); // start the cursor at the current block
    await openPlan();
    const engine = { address: ADDR.loanEngine, abi: polarisLoanEngineAbi as never };
    chainEmits([
      { ...engine, eventName: "InstallmentCollected", args: { loanId: 1n, caller: ADDR.collections, amount: 50_383_562n } },
      { ...engine, eventName: "InstallmentPaid", args: { loanId: 1n, borrower: buyer.address, installmentIndex: 0, amount: 50_383_562n, onTime: true } },
      { address: ADDR.collections, abi: collectionsReceiverAbi as never, eventName: "CollectionsRun", args: { tasks: 1n, executed: 1n, skipped: 0n } },
    ]);
    const first = await syncChain();
    expect(first.events).toBe(1);
    const [collected] = await eventsOfType("installment.collected");
    expect(collected?.data).toMatchObject({ planId: "1", installment: 1, installments: 4, amount: "50.383562", remaining: "151.150684", chainId: 31337 });
    expect((await getDb().plans.get("1"))?.installmentsPaid).toBe(1);
    expect((await getDb().collectorRuns.get("cre"))?.executed).toBe(1);

    // The buyer pays the rest early: one repayment completes three instalments and the plan.
    chainEmits([
      { ...engine, eventName: "InstallmentPaid", args: { loanId: 1n, borrower: buyer.address, installmentIndex: 1, amount: 151_150_684n, onTime: true } },
      { ...engine, eventName: "LoanFullyRepaid", args: { loanId: 1n, borrower: buyer.address } },
    ]);
    await syncChain();
    expect((await eventsOfType("installment.collected")).map((e) => e.data.installment as number).sort()).toEqual([1, 2, 3, 4]);
    const [completed] = await eventsOfType("plan.completed");
    expect(completed?.data).toMatchObject({ planId: "1", total: "201.534246" });
    expect((await getDb().plans.get("1"))?.state).toBe("repaid");
  });

  it("installment.failed follows the dunning ladder: one event per rung, not one per CRE run", async () => {
    await syncChain();
    await openPlan();
    const reason = encodeErrorResult({ abi: polarisLoanEngineAbi, errorName: "InsufficientBalance", args: [1n, 50_383_562n] });
    const skip = { address: ADDR.collections, abi: collectionsReceiverAbi as never, eventName: "TaskSkipped", args: { action: 1, id: 1n, reason } };
    chainEmits([skip]);
    chainEmits([skip]); // the next minute's run: same miss
    await syncChain();
    const failed = await eventsOfType("installment.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ planId: "1", installment: 1, amount: "50.383562", reason: "insufficient_funds", attempt: 1 });
    expect(Date.parse(failed[0]?.data.nextAttemptAt as string)).toBe(Number(env.chain.timestamp) * 1000 + 6 * 3_600_000);
    expect((await getDb().plans.get("1"))?.state).toBe("dunning");

    const stale = encodeErrorResult({ abi: polarisLoanEngineAbi, errorName: "NotDue" });
    chainEmits([{ ...skip, args: { action: 1, id: 1n, reason: stale } }]);
    await syncChain();
    expect(await eventsOfType("installment.failed")).toHaveLength(1);
  });

  it("plan.liquidated", async () => {
    await syncChain();
    await openPlan();
    chainEmits([{ address: ADDR.loanEngine, abi: polarisLoanEngineAbi as never, eventName: "LoanLiquidated", args: { loanId: 1n, borrower: buyer.address, outstanding: 151_150_684n, recovered: 100_000_000n } }]);
    await syncChain();
    const [liquidated] = await eventsOfType("plan.liquidated");
    expect(liquidated?.data).toMatchObject({ planId: "1", outstanding: "151.150684", recovered: "100.00" });
    expect((await getDb().plans.get("1"))?.state).toBe("written_off");
  });

  it("a direct payment from a buyer's own wallet (no relayer, no session)", async () => {
    await syncChain();
    chainEmits([
      {
        address: ADDR.payments,
        abi: polarisPaymentsAbi as never,
        eventName: "PaymentMade",
        args: { paymentId: `0x${"ab".repeat(32)}`, payer: buyer.address, merchant: merchant.account.address, amount: 25_000_000n, fee: 125_000n, orderId: "wallet-1" },
      },
    ]);
    await syncChain();
    const [paid] = await eventsOfType("payment.succeeded");
    expect(paid?.data).toMatchObject({ orderId: "wallet-1", sessionId: null, metadata: {}, amount: "25.00", fee: "0.125" });
  });

  it("ignores events for merchants that aren't ours, and never handles a log twice", async () => {
    await syncChain();
    const spec: LogSpec = {
      address: ADDR.payments,
      abi: polarisPaymentsAbi as never,
      eventName: "PaymentMade",
      args: { paymentId: `0x${"cd".repeat(32)}`, payer: buyer.address, merchant: "0x9999999999999999999999999999999999999999", amount: 1n, fee: 0n, orderId: "x" },
    };
    chainEmits([spec]);
    await syncChain();
    expect(await getDb().webhookEvents.count()).toBe(0);
    // Rewind the cursor: the same logs again change nothing.
    await getDb().cursors.upsert({ id: "logs", block: 0, updatedAt: new Date().toISOString() });
    await openPlan();
    const before = await getDb().webhookEvents.count();
    await syncChain();
    expect(await getDb().webhookEvents.count()).toBe(before);
  });
});

describe("subscriptions", () => {
  it("the Subscribe permit keeps what the buyer's other subscriptions need: allowance + this plan's 12 periods", async () => {
    const { GET: publicGet } = await import("@/app/api/public/sessions/[id]/route");
    const session = await newSession(merchant, { amount: "9.99", modes: ["subscribe"], subscription: { interval: "month" } });
    // The buyer already subscribes elsewhere: 30.00 still authorised to PolarisPayments.
    env.chain.reads.allowance = (args) => {
      const [owner, spender] = args as [string, string];
      return owner.toLowerCase() === buyer.address.toLowerCase() && spender.toLowerCase() === ADDR.payments.toLowerCase() ? 30_000_000n : 0n;
    };
    const pub = (await json(await publicGet(request("GET", `/x?buyer=${buyer.address}`), params({ id: session.id })))).body.data;
    expect(pub.buyer.subscription).toEqual({ allowance: "30000000", periodsAuthorised: 12, permitValue: String(30_000_000n + 9_990_000n * 12n) });

    // A checkout without a subscription has no such block.
    const plain = await newSession(merchant, { modes: ["now"] });
    const other = (await json(await publicGet(request("GET", `/x?buyer=${buyer.address}`), params({ id: plain.id })))).body.data;
    expect(other.buyer.subscription).toBeNull();
  });

  it("publishes the plan on chain, subscribes, and sends subscription.charged then subscription.canceled", async () => {
    await syncChain();
    const session = await newSession(merchant, { amount: "9.99", modes: ["subscribe"], subscription: { interval: "month" } });
    const { GET: publicGet } = await import("@/app/api/public/sessions/[id]/route");
    const pub = (await json(await publicGet(request("GET", "/x"), params({ id: session.id })))).body.data;
    expect(pub.subscription).toMatchObject({ planId: "7", periodSeconds: 2_592_000, pricePerPeriodUnits: "9990000", periodsAuthorised: 12 });
    expect(env.chain.relayed[0]?.to).toBe(ADDR.payments); // createPlanFor, by the relayer

    const deadline = BigInt(inSeconds(600));
    const intent = { buyer: buyer.address, merchant: merchant.account.address, planId: 7n, pricePerPeriod: 9_990_000n, periodSeconds: 2_592_000n, orderId: session.orderId as string, nonce: 0n, deadline };
    const signature = await buyer.signTypedData({ domain: checkoutDomain, types: TYPES.SubscribeIntent, primaryType: "SubscribeIntent", message: intent });
    const permitDeadline = BigInt(inSeconds(1800));
    const permitSig = await buyer.signTypedData({
      domain: stablecoinDomain,
      types: TYPES.Permit,
      primaryType: "Permit",
      message: { owner: buyer.address, spender: ADDR.payments, value: 9_990_000n * 12n, nonce: 0n, deadline: permitDeadline },
    });
    env.chain.reads.getSubscription = () => ({ subscriber: buyer.address, planId: 7n, nextChargeAt: env.chain.timestamp + 2_592_000n, periodsCharged: 1 });
    const res = await json(
      await relayRoute(
        request("POST", "/api/relay", {
          body: {
            type: "subscribe",
            sessionId: session.id,
            intent: { buyer: buyer.address, planId: "7", pricePerPeriod: "9990000", periodSeconds: "2592000", nonce: "0", deadline: String(deadline) },
            signature,
            permit: { value: String(9_990_000n * 12n), deadline: String(permitDeadline), signature: permitSig },
          },
        }),
        params({}),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ subscriptionId: "1" });
    const [charged] = await eventsOfType("subscription.charged");
    expect(charged?.data).toMatchObject({ subscriptionId: "1", planId: "7", subscriber: buyer.address, amount: "9.99", period: 1, orderId: session.orderId, sessionId: session.id });
    expect((await getDb().sessions.get(session.id))?.payment).toMatchObject({ mode: "subscribe", subscriptionId: "1" });

    chainEmits([{ address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "SubscriptionCancelled", args: { subId: 1n, by: buyer.address } }]);
    await syncChain();
    const [canceled] = await eventsOfType("subscription.canceled");
    expect(canceled?.data).toMatchObject({ subscriptionId: "1", canceledBy: "subscriber" });
  });
});

describe("webhook delivery", () => {
  async function queueTestDelivery(): Promise<string> {
    const { body } = await json(await listWebhooks(request("GET", "/api/webhooks"), params({})));
    return body.data.endpoints[0].id as string;
  }

  it("the dashboard's test event is sent now, signed like a live one", async () => {
    const endpointId = await queueTestDelivery();
    const res = await json(await testEvent(request("POST", `/api/webhooks/${endpointId}/test`), params({ id: endpointId })));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ event: "payment.succeeded", status: 200, attempt: 1, test: true, simulated: false, state: "succeeded" });
    const sent = env.deliveries[0];
    const event = verifyWebhook(sent?.body as string, sent?.headers["polaris-signature"], merchant.webhookSecret as string);
    expect(event.livemode).toBe(false);
  });

  it("retries on the schedule and records every attempt", async () => {
    const endpointId = await queueTestDelivery();
    env.respondWith(500);
    const res = await json(await testEvent(request("POST", `/api/webhooks/${endpointId}/test`), params({ id: endpointId })));
    expect(res.body.data).toMatchObject({ state: "pending", status: 500, attempt: 1 });
    const next = Date.parse(res.body.data.nextAttemptAt);
    expect(next - Date.now()).toBeGreaterThan(55_000);

    env.respondWith(204);
    expect(await dispatchDue({ nowMs: Date.now() })).toMatchObject({ attempted: 0 }); // not due yet
    expect(await dispatchDue({ nowMs: next + 1 })).toMatchObject({ attempted: 1, succeeded: 1 });
    const [delivery] = await getDb().webhookDeliveries.find({});
    expect(delivery?.attempts.map((a) => a.status)).toEqual([500, 204]);
    expect(env.deliveries.map((d) => d.headers["polaris-delivery-attempt"])).toEqual(["1", "2"]);
    // Every retry sends the same bytes, signed with a fresh timestamp.
    expect(env.deliveries[0]?.body).toBe(env.deliveries[1]?.body);
  });

  it("gives up after the last attempt, and can be retried by hand", async () => {
    const endpointId = await queueTestDelivery();
    env.respondWith(503);
    await testEvent(request("POST", "/x"), params({ id: endpointId }));
    let now = Date.now();
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      now += 24 * 3_600_000;
      await dispatchDue({ nowMs: now });
    }
    const [failed] = await getDb().webhookDeliveries.find({});
    expect(failed?.state).toBe("failed");
    expect(failed?.attempts).toHaveLength(MAX_DELIVERY_ATTEMPTS);

    env.respondWith(200);
    const retried = await json(await retryRoute(request("POST", "/x"), params({ id: failed?.id as string })));
    expect(retried.body.data.state).toBe("succeeded");
  });

  it("the cron route runs a pass for schedulers, behind CRON_SECRET", async () => {
    expect((await tick(request("GET", "/api/cron/tick"), params({}))).status).toBe(401);
    const ok = await json(await tick(request("GET", "/api/cron/tick", { headers: { authorization: "Bearer cron-test-secret" } }), params({})));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toHaveProperty("webhooks");
  });

  it("our signature matches the header format the SDK expects byte for byte", async () => {
    const endpointId = await queueTestDelivery();
    await testEvent(request("POST", "/x"), params({ id: endpointId }));
    const sent = env.deliveries[0];
    expect(sent?.headers["polaris-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(merchant.webhookSecret as string, sent?.body as string, sent?.headers["polaris-signature"]).ok).toBe(true);
  });
});

describe("payouts", () => {
  it("a signed withdrawal is relayed as AUSD transferWithAuthorization, then payout.paid", async () => {
    const destination = "0x5555555555555555555555555555555555555555" as Address;
    const validBefore = inSeconds(1800);
    const nonce = `0x${"42".repeat(32)}` as Hex;
    const signature = await merchant.account.signTypedData({
      domain: stablecoinDomain,
      types: TYPES.TransferWithAuthorization,
      primaryType: "TransferWithAuthorization",
      message: { from: merchant.account.address, to: destination, value: 25_000_000n, validAfter: 0n, validBefore: BigInt(validBefore), nonce },
    });
    const res = await json(
      await withdrawRoute(
        request("POST", "/api/payouts", { body: { amountCents: 2500, destination, authorization: { validAfter: "0", validBefore, nonce, signature } } }),
        params({}),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "paid", amountCents: 2500, destination, signed: true });
    expect(env.chain.relayed[0]?.to).toBe(ADDR.stablecoin);
    const [paid] = await eventsOfType("payout.paid");
    expect(paid?.data).toMatchObject({ amount: "25.00", destination, automatic: false, chainId: 31337 });
  });

  it("refuses a withdrawal below the relayer's minimum with a clear message, before anything is signed or sent", async () => {
    signIn({ userId: merchant.userId, walletAddress: merchant.account.address, walletId: "wal_1" });
    const res = await json(
      await withdrawRoute(
        request("POST", "/api/payouts", {
          body: { amountCents: 5, destination: "0x5555555555555555555555555555555555555555", authorization: { validAfter: "0", validBefore: inSeconds(1800), nonce: `0x${"44".repeat(32)}`, signature: `0x${"11".repeat(65)}` } },
        }),
        params({}),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "amount_too_small", message: "Withdraw at least $0.10." });
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("refuses a withdrawal signed for another destination", async () => {
    const validBefore = inSeconds(1800);
    const nonce = `0x${"43".repeat(32)}` as Hex;
    const signature = await merchant.account.signTypedData({
      domain: stablecoinDomain,
      types: TYPES.TransferWithAuthorization,
      primaryType: "TransferWithAuthorization",
      message: { from: merchant.account.address, to: "0x6666666666666666666666666666666666666666", value: 25_000_000n, validAfter: 0n, validBefore: BigInt(validBefore), nonce },
    });
    const res = await json(
      await withdrawRoute(
        request("POST", "/api/payouts", {
          body: { amountCents: 2500, destination: "0x5555555555555555555555555555555555555555", authorization: { validAfter: "0", validBefore, nonce, signature } },
        }),
        params({}),
      ),
    );
    expect(res.status).toBe(403);
    expect(env.chain.relayed).toHaveLength(0);
  });
});

describe("merchant onboarding on chain", () => {
  it("the payout wallet signs a Registration, the relayer sends registerFor, the registry admin activates", async () => {
    const activatorKey = generatePrivateKey();
    env = setupServer({ REGISTRY_ACTIVATOR: "local", REGISTRY_OWNER_PRIVATE_KEY: activatorKey });
    emitLikeTheContracts(env);
    let registered = false;
    env.chain.reads.merchantOf = () => ({ payoutAddress: merchant.account.address, name: "", registeredAt: registered ? 1n : 0n, active: false, maxOrderValue: 0n });
    signIn({ userId: merchant.userId, walletAddress: merchant.account.address, walletId: "wal_1" });
    await meUpdate(request("POST", "/api/me", { body: { businessName: "Estudio Sur" } }), params({}));

    const got = await json(await registrationGet(request("GET", "/api/merchant/registration"), params({})));
    const typed = got.body.data.typedData;
    expect(typed).toMatchObject({ primaryType: "Registration", domain: { name: "MerchantRegistry", version: "1", chainId: 31337 }, message: { merchant: merchant.account.address, name: "Estudio Sur", payoutAddress: merchant.account.address, nonce: "0" } });

    const signature = await merchant.account.signTypedData({
      domain: typed.domain,
      types: TYPES.Registration,
      primaryType: "Registration",
      message: { ...typed.message, nonce: BigInt(typed.message.nonce), deadline: BigInt(typed.message.deadline) },
    });
    env.chain.onSend = () => {
      registered = true;
      return [];
    };
    const done = await json(await registrationPost(request("POST", "/api/merchant/registration", { body: { signature, deadline: typed.message.deadline } }), params({})));
    expect(done.status).toBe(200);
    expect(done.body.data.merchant.registration).toMatchObject({ state: "active" });
    const [registerTx, capTx, activateTx] = env.chain.relayed;
    expect(registerTx?.to).toBe(ADDR.registry);
    expect(capTx?.to).toBe(ADDR.registry);
    expect(activateTx?.to).toBe(ADDR.registry);
    expect(env.chain.relayed).toHaveLength(3);
  });

  it("with MERCHANT_ACTIVATION_MIN_PAYMENTS, a new merchant waits for paid orders from different customers before Pay in 4", async () => {
    const activatorKey = generatePrivateKey();
    env = setupServer({ REGISTRY_ACTIVATOR: "local", REGISTRY_OWNER_PRIVATE_KEY: activatorKey, MERCHANT_ACTIVATION_MIN_PAYMENTS: "2" });
    emitLikeTheContracts(env);
    merchant = await merchantWithKeys({ webhook: true });
    let registered = false;
    env.chain.reads.merchantOf = () => ({ payoutAddress: merchant.account.address, name: "", registeredAt: registered ? 1n : 0n, active: false, maxOrderValue: 0n });
    signIn({ userId: merchant.userId, walletAddress: merchant.account.address, walletId: "wal_1" });
    await meUpdate(request("POST", "/api/me", { body: { businessName: "Estudio Sur" } }), params({}));
    const typed = (await json(await registrationGet(request("GET", "/api/merchant/registration"), params({})))).body.data.typedData;
    const signature = await merchant.account.signTypedData({
      domain: typed.domain,
      types: TYPES.Registration,
      primaryType: "Registration",
      message: { ...typed.message, nonce: BigInt(typed.message.nonce), deadline: BigInt(typed.message.deadline) },
    });
    env.chain.onSend = () => {
      registered = true;
      return [];
    };
    const done = await json(await registrationPost(request("POST", "/api/merchant/registration", { body: { signature, deadline: typed.message.deadline } }), params({})));
    expect(done.body.data.merchant.registration).toMatchObject({ state: "registered" });
    expect(done.body.data.merchant.registration.error).toMatch(/2 different customers \(0 so far\)/);
    expect(env.chain.relayed).toHaveLength(1); // registerFor only: no cap, no activation

    await syncChain();
    const pay = (payer: Address, orderId: string) =>
      chainEmits([{ address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "PaymentMade", args: { paymentId: orderKey(merchant.account.address, orderId), payer, merchant: merchant.account.address, amount: 5_000_000n, fee: 25_000n, orderId } }]);
    const first = privateKeyToAccount(generatePrivateKey()).address;
    pay(first, "o-1");
    pay(first, "o-2"); // the same customer twice is still one
    await syncChain();
    expect((await getDb().merchants.get(merchant.userId))?.registration.state).toBe("registered");
    pay(privateKeyToAccount(generatePrivateKey()).address, "o-3");
    await syncChain();
    expect((await getDb().merchants.get(merchant.userId))?.registration).toMatchObject({ state: "active", error: null });
    expect(env.chain.relayed.map((t) => t.functionName)).toEqual(["registerFor", "setMaxOrderValue", "setActive"]);
  });

  it("refuses a registration signed by anyone but the merchant's wallet", async () => {
    env.chain.reads.merchantOf = () => ({ payoutAddress: merchant.account.address, name: "", registeredAt: 0n, active: false, maxOrderValue: 0n });
    signIn({ userId: merchant.userId, walletAddress: merchant.account.address, walletId: "wal_1" });
    await meUpdate(request("POST", "/api/me", { body: { businessName: "Estudio Sur" } }), params({}));
    const got = await json(await registrationGet(request("GET", "/x"), params({})));
    const typed = got.body.data.typedData;
    const impostor = privateKeyToAccount(generatePrivateKey());
    const signature = await impostor.signTypedData({
      domain: typed.domain,
      types: TYPES.Registration,
      primaryType: "Registration",
      message: { ...typed.message, nonce: BigInt(typed.message.nonce), deadline: BigInt(typed.message.deadline) },
    });
    const res = await json(await registrationPost(request("POST", "/x", { body: { signature, deadline: typed.message.deadline } }), params({})));
    expect(res.status).toBe(403);
    expect(env.chain.relayed).toHaveLength(0);
  });
});
