import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { polarisPaymentsAbi } from "@polarispay/contracts/abi";
import { GET as health } from "@/app/api/health/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { getDb } from "@/server/db";
import { getConfig, productionProblems, resetConfig } from "@/server/env";
import { HttpError, readJson } from "@/server/http";
import { MAX_LOG_ATTEMPTS } from "@/server/ingest/ingest";
import { syncChain } from "@/server/ingest/sync";
import { createPayoutPolicy } from "@/server/payout-policy";

import { makeLog, type LogSpec } from "./helpers/fake-chain";
import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { merchantWithKeys, newSession, orderKey, type Merchant } from "./helpers/flows";

let env: TestEnv;
const nodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  env = setupServer();
});

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  delete process.env.PRIVY_PAYOUT_SIGNER_ID;
  delete process.env.PRIVY_PAYOUT_SIGNER_KEY;
  delete process.env.PRIVY_ADMIN_QUORUM_ID;
  resetConfig();
});

describe("GET /api/health", () => {
  it("tells the public whether production is ready, and only the operator what is missing", async () => {
    const pub = await json(await health(request("GET", "/api/health"), params({})));
    expect(pub.status).toBe(200);
    expect(pub.body.data).toHaveProperty("productionReady");
    expect(pub.body.data).not.toHaveProperty("problems");
    const wrong = await json(await health(request("GET", "/api/health", { headers: { authorization: "Bearer nope" } }), params({})));
    expect(wrong.body.data).not.toHaveProperty("problems");
    const operator = await json(await health(request("GET", "/api/health", { headers: { authorization: "Bearer cron-test-secret" } }), params({})));
    expect(operator.body.data.problems).toEqual([]);
  });
});

describe("request bodies are read with a limit, even without Content-Length", () => {
  function chunked(bytes: number): Request {
    const chunk = new TextEncoder().encode(`"${"a".repeat(1022)}",`);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return new Request("http://localhost:3100/api/relay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body,
      duplex: "half",
    } as RequestInit);
  }

  it("refuses a chunked body over the limit after reading just past the limit", async () => {
    const req = chunked(10 * 1024 * 1024);
    await expect(readJson(req)).rejects.toMatchObject({ status: 413, code: "too_large" });
  });

  it("the relay answers 413 to it", async () => {
    const res = await relayRoute(chunked(1024 * 1024), params({}));
    expect(res.status).toBe(413);
  });

  it("still reads a small chunked body", async () => {
    const small = new Request("http://x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"a":'));
          c.enqueue(new TextEncoder().encode("1}"));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(await readJson(small)).toEqual({ a: 1 });
  });
});

describe("a log whose handler keeps failing is set aside, not retried forever", () => {
  let merchant: Merchant;
  beforeEach(async () => {
    merchant = await merchantWithKeys();
  });

  function emit(specs: LogSpec[]): Hex {
    env.chain.blockNumber += 1n;
    const txHash = `0x${env.chain.blockNumber.toString(16).padStart(64, "0")}` as Hex;
    env.chain.logs.push(...specs.map((s, i) => makeLog(s, { txHash, logIndex: i, blockNumber: env.chain.blockNumber })));
    return txHash;
  }

  it(`after ${MAX_LOG_ATTEMPTS} failures the cursor moves past it, and the logs behind it are handled`, async () => {
    await syncChain();
    const buyer = privateKeyToAccount(generatePrivateKey());
    const poison = await newSession(merchant, { orderId: "poison-order" });
    const later = await newSession(merchant, { orderId: "later-order" });
    const paid = (orderId: string, amount: bigint) => ({
      address: ADDR.payments,
      abi: polarisPaymentsAbi as never,
      eventName: "PaymentMade",
      args: { paymentId: orderKey(merchant.account.address, orderId), payer: buyer.address, merchant: merchant.account.address, amount, fee: 0n, orderId },
    });
    const bad = emit([paid("poison-order", 200_000_000n)]);
    emit([paid("later-order", 200_000_000n)]);

    // The poison log's handler throws (a bug, a record it can't parse): here, the payments table refuses it.
    const payments = getDb().payments;
    const upsert = payments.upsert.bind(payments);
    payments.upsert = (async (doc: { orderId: string }) => {
      if (doc.orderId === "poison-order") throw new Error("boom");
      return upsert(doc as never);
    }) as typeof payments.upsert;

    for (let i = 1; i < MAX_LOG_ATTEMPTS; i++) await expect(syncChain()).rejects.toThrow("boom");
    expect((await getDb().sessions.get(later.id))?.status).toBe("open"); // held behind it until now

    await syncChain();
    expect((await getDb().sessions.get(later.id))?.status).toBe("complete");
    expect((await getDb().sessions.get(poison.id))?.status).toBe("open");
    const dead = await getDb().failedLogs.get(`${bad}:0`);
    expect(dead).toMatchObject({ attempts: MAX_LOG_ATTEMPTS, event: "payments.PaymentMade", lastError: "boom" });
    expect(dead?.deadAt).toBeTruthy();
    payments.upsert = upsert;
  });
});

describe("automatic payout policies need an offline owner in production", () => {
  function production(extra: Record<string, string>) {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    Object.assign(process.env, { PRIVY_PAYOUT_SIGNER_ID: "signer_1", PRIVY_PAYOUT_SIGNER_KEY: "key_1", ...extra });
    resetConfig();
  }

  it("refuses to create one owned by the app, and names the missing setting to the operator", async () => {
    production({});
    const error = await createPayoutPolicy("mer_1", "0x5555555555555555555555555555555555555555").catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503, code: "payouts_not_secured" });
    expect(productionProblems(getConfig()).some((p) => p.includes("PRIVY_ADMIN_QUORUM_ID"))).toBe(true);
  });

  it("goes ahead with the admin quorum set (Privy itself is off in tests)", async () => {
    production({ PRIVY_ADMIN_QUORUM_ID: "quorum_admin" });
    expect(await createPayoutPolicy("mer_1", "0x5555555555555555555555555555555555555555")).toBeNull();
    expect(productionProblems(getConfig()).some((p) => p.includes("PRIVY_ADMIN_QUORUM_ID"))).toBe(false);
  });
});
