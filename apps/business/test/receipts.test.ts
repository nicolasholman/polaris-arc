import { deriveReceiptKeys, inboxRegistrationMessage, openReceipt, receiptsReadMessage, toHex, type ReceiptKeys } from "@polaris/receipts";
import { SEALED_DESCRIPTION } from "@polaris/db";
import type { Hex, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { polarisLoanEngineAbi } from "@polarispay/contracts/abi";
import { GET as buyerBookRoute } from "@/app/api/public/buyers/[address]/route";
import { GET as publicSessionRoute } from "@/app/api/public/sessions/[id]/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { POST as readRoute, GET as readGet } from "@/app/api/receipts/route";
import { POST as inboxRoute } from "@/app/api/receipts/inbox/route";
import { GET as retrieveRoute } from "@/app/api/v1/checkout/sessions/[id]/route";
import { POST as createSessionRoute } from "@/app/api/v1/checkout/sessions/route";
import { getDb } from "@/server/db";
import { syncChain } from "@/server/ingest/sync";
import { TYPES } from "@/server/relayer/typed-data";

import { makeLog, type LogSpec } from "./helpers/fake-chain";
import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { checkoutDomain, emitLikeTheContracts, inSeconds, merchantWithKeys, newSession, signPayNow, stablecoinDomain, type Merchant } from "./helpers/flows";

/**
 * Receipts only the buyer can read (docs/research/mera.md §16): the buyer's
 * Face ID derives an inbox key pair; they register its public half with
 * their account's signature; what they buy is sealed to it at settlement and
 * the plaintext is dropped; only their keys (and their signature, to fetch)
 * open it. Here a fixed 32-byte "PRF output" stands in for Face ID.
 */

let env: TestEnv;
let merchant: Merchant;
let buyer: LocalAccount;
let keys: ReceiptKeys;

const DESCRIPTION = "Brand identity package";
const LINE_ITEMS = [
  { name: "Logo suite", quantity: 1, unitAmount: "150.00" },
  { name: "Brand guidelines", quantity: 2, unitAmount: "25.00" },
];

beforeEach(async () => {
  env = setupServer();
  emitLikeTheContracts(env);
  merchant = await merchantWithKeys({ webhook: true });
  buyer = privateKeyToAccount(generatePrivateKey());
  keys = await deriveReceiptKeys(crypto.getRandomValues(new Uint8Array(32)));
});

async function register(account: LocalAccount = buyer, k: ReceiptKeys = keys) {
  const inboxPublicKey = toHex(k.inboxPublicKey);
  const signature = await account.signMessage({ message: inboxRegistrationMessage(inboxPublicKey) });
  return json(await inboxRoute(request("POST", "/api/receipts/inbox", { body: { address: account.address, inboxPublicKey, signature } }), params({})));
}

async function read(account: LocalAccount = buyer, issuedAt = Math.floor(Date.now() / 1000), signer: LocalAccount = account) {
  const signature = await signer.signMessage({ message: receiptsReadMessage(account.address, issuedAt) });
  return json(await readRoute(request("POST", "/api/receipts", { body: { address: account.address, issuedAt, signature } }), params({})));
}

const lineItemsBody = { lineItems: [{ name: "Logo suite", quantity: 1, unitAmount: "150.00" }, { name: "Brand guidelines", quantity: 2, unitAmount: "25.00" }] };

async function payNow(opts: { idempotencyKey?: string } = {}): Promise<Record<string, any>> {
  const session = opts.idempotencyKey
    ? (
        await json(
          await createSessionRoute(
            request("POST", "/api/v1/checkout/sessions", {
              headers: { authorization: `Bearer ${merchant.secret}`, "idempotency-key": opts.idempotencyKey },
              body: { description: DESCRIPTION, ...lineItemsBody, modes: ["now"], successUrl: "https://studio.example/thanks", orderId: "INV-idem" },
            }),
            params({}),
          ),
        )
      ).body.data
    : await newSession(merchant, { amount: undefined, description: DESCRIPTION, ...lineItemsBody });
  const auth = await signPayNow(buyer, merchant.account.address, session.orderId, 200_000_000n);
  const res = await json(await relayRoute(request("POST", "/api/relay", { body: { type: "pay", sessionId: session.id, buyer: buyer.address, ...auth } }), params({})));
  expect(res.status).toBe(200);
  return session;
}

async function openPlan(): Promise<Record<string, any>> {
  const session = await newSession(merchant, { description: DESCRIPTION });
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
  return session;
}

async function subscribe(): Promise<Record<string, any>> {
  const session = await newSession(merchant, { amount: "9.99", description: "Halcyon Coffee Club", modes: ["subscribe"], subscription: { interval: "month" } });
  // The hosted checkout's read publishes the subscription plan on chain (createPlanFor, by the relayer).
  await publicSessionRoute(request("GET", `/api/public/sessions/${session.id}`), params({ id: session.id }));
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
  const res = await relayRoute(
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
  );
  expect(res.status).toBe(200);
  return session;
}

function chainEmits(specs: LogSpec[]): Hex {
  env.chain.blockNumber += 1n;
  const txHash = `0x${env.chain.blockNumber.toString(16).padStart(64, "0")}` as Hex;
  env.chain.logs.push(...specs.map((s, i) => makeLog(s, { txHash, logIndex: i, blockNumber: env.chain.blockNumber })));
  return txHash;
}

/** Every record the database holds, as text: where a description must not be after settlement. */
async function everything(): Promise<string> {
  const db = getDb();
  const all = await Promise.all(Object.entries(db).map(async ([name, c]) => [name, await (c as { find: () => Promise<unknown[]> }).find()] as const));
  // A payment link and a subscription plan are the merchant's catalogue (its own price list), not a purchase.
  return JSON.stringify(all.filter(([name]) => name !== "links" && name !== "subscriptionPlans"));
}

/** Open what the API serves with the buyer's keys. */
async function opened(account: LocalAccount = buyer, k: ReceiptKeys = keys) {
  const res = await read(account);
  expect(res.status).toBe(200);
  const rows = res.body.data.receipts as Array<{ id: string; enc: string; ct: string; kind: string; txHash: Hex }>;
  return Promise.all(rows.map(async (r) => ({ row: r, body: await openReceipt(k, account.address, r) })));
}

describe("POST /api/receipts/inbox", () => {
  it("registers the inbox key with the account's own signature over it", async () => {
    const res = await register();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ address: buyer.address, inboxPublicKey: toHex(keys.inboxPublicKey), sealed: 0 });
    expect(await getDb().receiptInboxes.get(buyer.address.toLowerCase())).toMatchObject({ publicKey: toHex(keys.inboxPublicKey) });
  });

  it("refuses a key signed by anyone else (a Face ID ceremony, or a stranger, proves nothing)", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const inboxPublicKey = toHex(keys.inboxPublicKey);
    const signature = await stranger.signMessage({ message: inboxRegistrationMessage(inboxPublicKey) });
    const res = await json(await inboxRoute(request("POST", "/api/receipts/inbox", { body: { address: buyer.address, inboxPublicKey, signature } }), params({})));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("bad_signature");
    // A signature over another key doesn't register this one.
    const other = await deriveReceiptKeys(new Uint8Array(32).fill(1));
    const sigOther = await buyer.signMessage({ message: inboxRegistrationMessage(toHex(other.inboxPublicKey)) });
    expect((await inboxRoute(request("POST", "/api/receipts/inbox", { body: { address: buyer.address, inboxPublicKey, signature: sigOther } }), params({}))).status).toBe(401);
    expect(await getDb().receiptInboxes.count()).toBe(0);
  });

  it("refuses a malformed key, and answers other methods with a JSON 405", async () => {
    const signature = await buyer.signMessage({ message: inboxRegistrationMessage("0x1234") });
    const res = await json(await inboxRoute(request("POST", "/api/receipts/inbox", { body: { address: buyer.address, inboxPublicKey: "0x1234", signature } }), params({})));
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("inboxPublicKey");
    expect((await readGet(request("GET", "/api/receipts"), params({}))).status).toBe(405);
  });
});

describe("Pay now: sealed at settlement, plaintext dropped", () => {
  it("keeps only the sealed copy, which only the buyer's keys open", async () => {
    expect((await register()).status).toBe(200);
    const session = await payNow();

    const db = getDb();
    const payment = (await db.payments.find({ payer: buyer.address.toLowerCase() }))[0];
    expect(payment).toMatchObject({ kind: "now", description: SEALED_DESCRIPTION, receiptId: payment?.id });
    const stored = await db.sessions.get(session.id);
    expect(stored).toMatchObject({ status: "complete", description: SEALED_DESCRIPTION, lineItems: [] });
    expect(stored?.sealedAt).toBeTruthy();
    // Nowhere in the database: not the description, not a line item.
    const dump = await everything();
    expect(dump).not.toContain(DESCRIPTION);
    expect(dump).not.toContain("Logo suite");

    const [receipt, ...rest] = await opened();
    expect(rest).toHaveLength(0);
    expect(receipt?.row).toMatchObject({ id: payment?.id, kind: "payment", txHash: payment?.txHash });
    expect(receipt?.body).toMatchObject({ kind: "payment", description: DESCRIPTION, lineItems: LINE_ITEMS, amount: "200.00", orderId: session.orderId, txHash: payment?.txHash });

    // The merchant's API and the public checkout read say it's sealed; the order reference stays.
    const retrieved = (await json(await retrieveRoute(request("GET", `/api/v1/checkout/sessions/${session.id}`, { headers: { authorization: `Bearer ${merchant.secret}` } }), params({ id: session.id })))).body.data;
    expect(retrieved).toMatchObject({ paymentStatus: "paid", description: SEALED_DESCRIPTION, lineItems: [], orderId: session.orderId });
    const pub = (await json(await publicSessionRoute(request("GET", `/api/public/sessions/${session.id}`), params({ id: session.id })))).body.data;
    expect(pub.description).toBe(SEALED_DESCRIPTION);
  });

  it("drops it from the copy an Idempotency-Key replays too", async () => {
    await register();
    await payNow({ idempotencyKey: "order-INV-idem" });
    const [replay] = await getDb().idempotency.find({});
    expect(replay?.resourceId).toMatch(/^cs_test_/);
    expect(await everything()).not.toContain(DESCRIPTION);
    // The merchant's retry still gets its session back, sealed.
    const again = await json(
      await createSessionRoute(
        request("POST", "/api/v1/checkout/sessions", {
          headers: { authorization: `Bearer ${merchant.secret}`, "idempotency-key": "order-INV-idem" },
          body: { description: DESCRIPTION, ...lineItemsBody, modes: ["now"], successUrl: "https://studio.example/thanks", orderId: "INV-idem" },
        }),
        params({}),
      ),
    );
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ id: replay?.resourceId, description: SEALED_DESCRIPTION, lineItems: [] });
  });

  it("binds each ciphertext to its owner and id: swapped rows don't open", async () => {
    await register();
    await payNow();
    await payNow();
    const res = await read();
    const [a, b] = res.body.data.receipts as Array<{ id: string; enc: string; ct: string }>;
    expect(a && b).toBeTruthy();
    // The server serving b's ciphertext as a (or a's under another owner) is caught.
    await expect(openReceipt(keys, buyer.address, { id: a!.id, enc: b!.enc, ct: b!.ct })).rejects.toThrow();
    await expect(openReceipt(keys, privateKeyToAccount(generatePrivateKey()).address, a!)).rejects.toThrow();
    // Swapped in the database itself, the same.
    await getDb().receipts.update(a!.id, (r) => ({ ...r, enc: b!.enc, ct: b!.ct }));
    const swapped = (await read()).body.data.receipts.find((r: { id: string }) => r.id === a!.id);
    await expect(openReceipt(keys, buyer.address, swapped)).rejects.toThrow();
    expect((await openReceipt(keys, buyer.address, b!)).description).toBe(DESCRIPTION);
  });

  it("leaves a buyer without an inbox (an email account) exactly as before", async () => {
    const session = await payNow();
    const payment = (await getDb().payments.find({ payer: buyer.address.toLowerCase() }))[0];
    expect(payment).toMatchObject({ description: DESCRIPTION, receiptId: null });
    expect(await getDb().sessions.get(session.id)).toMatchObject({ description: DESCRIPTION, lineItems: [{ name: "Logo suite", quantity: 1, unitAmountCents: 15000 }, { name: "Brand guidelines", quantity: 2, unitAmountCents: 2500 }] });
    expect(await getDb().receipts.count()).toBe(0);
  });

  it("seals what settled before the buyer registered, the moment they do", async () => {
    const session = await payNow();
    expect(await everything()).toContain(DESCRIPTION);
    const res = await register();
    expect(res.body.data.sealed).toBe(1);
    expect(await everything()).not.toContain(DESCRIPTION);
    expect(await getDb().sessions.get(session.id)).toMatchObject({ description: SEALED_DESCRIPTION, lineItems: [] });
    const [receipt] = await opened();
    expect(receipt?.body).toMatchObject({ description: DESCRIPTION, lineItems: LINE_ITEMS });
    // Registering again seals nothing twice.
    expect((await register()).body.data.sealed).toBe(0);
  });
});

describe("Pay in 4 and the server's own receipts", () => {
  it("seals the plan at opening, and each collected instalment as the server writes it", async () => {
    await register();
    await syncChain();
    await openPlan();
    const db = getDb();
    expect(await db.plans.get("1")).toMatchObject({ description: SEALED_DESCRIPTION, receiptId: "plan:1" });
    expect(await db.payments.get("plan:1")).toMatchObject({ description: SEALED_DESCRIPTION, receiptId: "plan:1" });

    const engine = { address: ADDR.loanEngine, abi: polarisLoanEngineAbi as never };
    const tx = chainEmits([
      { ...engine, eventName: "InstallmentCollected", args: { loanId: 1n, caller: ADDR.collections, amount: 50_383_562n } },
      { ...engine, eventName: "InstallmentPaid", args: { loanId: 1n, borrower: buyer.address, installmentIndex: 0, amount: 50_383_562n, onTime: true } },
    ]);
    await syncChain();
    expect(await everything()).not.toContain(DESCRIPTION);

    const all = await opened();
    const plan = all.find((r) => r.row.id === "plan:1");
    expect(plan?.body).toMatchObject({ kind: "plan", description: DESCRIPTION, amount: "200.00", plan: { installments: 4, intervalSeconds: 604_800 } });
    expect(plan?.body.plan?.schedule).toHaveLength(4);
    const instalment = all.find((r) => r.row.id === "instalment:1:1");
    expect(instalment?.row.txHash).toBe(tx);
    expect(instalment?.body).toMatchObject({ kind: "instalment", installment: { index: 1, of: 4 }, amount: "50.383562", refersTo: "plan:1", description: null });
  });

  it("seals a subscription at its start, and each charge pointing at it", async () => {
    await register();
    const session = await subscribe();
    const db = getDb();
    expect(await db.subscriptions.get("1")).toMatchObject({ receiptId: "subscription:1" });
    expect(await db.payments.get("sub:1:1")).toMatchObject({ description: SEALED_DESCRIPTION, receiptId: "sub:1:1" });
    expect(await db.sessions.get(session.id)).toMatchObject({ description: SEALED_DESCRIPTION });
    expect(await everything()).not.toContain("Halcyon Coffee Club");

    const all = await opened();
    const start = all.find((r) => r.row.id === "subscription:1");
    expect(start?.body).toMatchObject({ kind: "subscription", description: "Halcyon Coffee Club", amount: "9.99", subscription: { interval: "month", intervalCount: 1 } });
    const charge = all.find((r) => r.row.id === "sub:1:1");
    expect(charge?.body).toMatchObject({ kind: "subscription-charge", period: 1, amount: "9.99", refersTo: "subscription:1", description: null });
  });
});

describe("POST /api/receipts", () => {
  it("serves ciphertext only for the account's own fresh signature", async () => {
    await register();
    await payNow();
    expect((await read()).body.data.receipts).toHaveLength(1);

    const stranger = privateKeyToAccount(generatePrivateKey());
    // A stranger signing for the buyer's address: refused.
    const forged = await read(buyer, Math.floor(Date.now() / 1000), stranger);
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("bad_signature");
    // The stranger's own request: their own (empty) receipts, never the buyer's.
    expect((await read(stranger)).body.data.receipts).toEqual([]);
    // An old signature: refused.
    const stale = await read(buyer, Math.floor(Date.now() / 1000) - 600);
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe("stale_request");
  });

  it("the public buyer book says which rows are sealed, never what's in them", async () => {
    await register();
    await payNow();
    const book = (await json(await buyerBookRoute(request("GET", `/api/public/buyers/${buyer.address}`), params({ address: buyer.address })))).body.data;
    expect(book.receiptsInbox).toBe(true);
    expect(book.receipts).toHaveLength(1);
    expect(book.receipts[0]).toEqual({ id: book.payments[0].id, kind: "payment", txHash: book.payments[0].txHash, amountUnits: "200000000", createdAt: expect.any(String) });
    expect(JSON.stringify(book)).not.toMatch(/"(enc|ct)"/);
  });
});
