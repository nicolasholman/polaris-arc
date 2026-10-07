import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as relayRoute } from "@/app/api/relay/route";
import { getDb } from "@/server/db";
import { reconcileRelays } from "@/server/ingest/sync";

import { json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { emitLikeTheContracts, inSeconds, merchantWithKeys, newSession, signPayNow, type Merchant } from "./helpers/flows";

/**
 * A relayed transaction can never land: the node drops it, or another
 * transaction takes its nonce. Such a relay used to stay "submitted" forever,
 * holding its checkout (409 payment_in_progress until the session expired)
 * and, once 20 of them piled up, keeping every newer relay and payout from
 * being reconciled.
 */

let env: TestEnv;
let merchant: Merchant;
const buyer = privateKeyToAccount(generatePrivateKey());

beforeEach(async () => {
  env = setupServer();
  emitLikeTheContracts(env);
  merchant = await merchantWithKeys({ webhook: true });
});

afterEach(() => {
  delete process.env.RELAYER_DROP_AFTER_MS;
});

const relay = (body: unknown) => relayRoute(request("POST", "/api/relay", { body }), params({}));

async function payBody(session: Record<string, any>, validBefore = inSeconds(900)) {
  const auth = await signPayNow(buyer, merchant.account.address, session.orderId, 200_000_000n, validBefore);
  return { type: "pay", sessionId: session.id, buyer: buyer.address, ...auth };
}

const relayOf = async (sessionId: string) => (await getDb().relays.find({ sessionId }))[0];

describe("a relay whose transaction never lands", () => {
  it("is marked failed once the node no longer knows it, which frees its checkout for another try", async () => {
    const session = await newSession(merchant);
    env.chain.dropNext = true;
    const first = await json(await relay(await payBody(session)));
    expect(first.body.data.status).toBe("submitted");

    // While it may still land, the checkout is held.
    const again = await json(await relay(await payBody(session, inSeconds(950))));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("payment_in_progress");

    // Too early to call it dropped: it stays submitted, and is only marked checked.
    expect(await reconcileRelays({ olderThanMs: 0 })).toEqual({ settled: 0, dropped: 0, waiting: 1 });
    expect((await relayOf(session.id))?.state).toBe("submitted");

    process.env.RELAYER_DROP_AFTER_MS = "0";
    expect(await reconcileRelays({ olderThanMs: 0 })).toEqual({ settled: 0, dropped: 1, waiting: 0 });
    expect(await relayOf(session.id)).toMatchObject({ state: "failed", error: { code: "dropped" } });

    const retried = await json(await relay(await payBody(session, inSeconds(1000))));
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe("confirmed");
    expect((await getDb().sessions.get(session.id))?.status).toBe("complete");
  });

  it("is marked failed when the relayer's nonce was used by another transaction", async () => {
    const session = await newSession(merchant);
    env.chain.slowReceipts = true;
    const first = await json(await relay(await payBody(session)));
    expect(first.body.data.status).toBe("submitted");
    env.chain.receipts.delete(first.body.data.txHash); // never mined
    const record = await relayOf(session.id);
    expect(typeof record?.nonce).toBe("number");
    expect(record?.from).toMatch(/^0x[0-9a-fA-F]{40}$/);

    process.env.RELAYER_DROP_AFTER_MS = "0";
    // The node still knows it and its nonce isn't used yet: it may still land.
    env.chain.minedNonce = record!.nonce!;
    expect(await reconcileRelays({ olderThanMs: 0 })).toMatchObject({ dropped: 0, waiting: 1 });
    // Another transaction took the nonce.
    env.chain.minedNonce = record!.nonce! + 1;
    expect(await reconcileRelays({ olderThanMs: 0 })).toMatchObject({ dropped: 1 });
    expect((await relayOf(session.id))?.error?.message).toMatch(/took this one's place/);
  });

  it("frees its checkout after RELAYER_DROP_AFTER_MS even before the reconciler has run", async () => {
    const session = await newSession(merchant);
    env.chain.dropNext = true;
    await relay(await payBody(session));
    process.env.RELAYER_DROP_AFTER_MS = "0";
    const retried = await json(await relay(await payBody(session, inSeconds(950))));
    expect(retried.status).toBe(200);
  });
});

describe("the reconciler pages past relays that never resolve", () => {
  it("25 stuck relays don't keep a newer one from being settled", async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 25; i++) {
      await getDb().relays.insert({
        id: `rly_stuck_${String(i).padStart(2, "0")}`,
        kind: "pay",
        state: "submitted",
        signer: null,
        to: merchant.account.address,
        txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
        blockNumber: null,
        sessionId: null,
        merchantId: null,
        result: null,
        error: null,
        createdAt: old,
        updatedAt: old,
      });
    }
    const session = await newSession(merchant);
    env.chain.slowReceipts = true;
    const late = await json(await relay(await payBody(session)));
    expect(late.body.data.status).toBe("submitted");
    // It is mined; only our wait timed out.
    env.chain.slowReceipts = false;

    const first = await reconcileRelays({ olderThanMs: 0 });
    expect(first.settled).toBe(0); // the 20 oldest, all stuck
    const second = await reconcileRelays({ olderThanMs: 0 });
    expect(second.settled).toBe(1);
    expect((await relayOf(session.id))?.state).toBe("confirmed");
    expect((await getDb().sessions.get(session.id))?.status).toBe("complete");
  });
});
