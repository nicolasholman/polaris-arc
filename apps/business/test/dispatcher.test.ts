import { beforeEach, describe, expect, it } from "vitest";

import { POST as createWebhook } from "@/app/api/webhooks/route";
import { getDb } from "@/server/db";
import { configureDispatcherForTests, dispatchDue } from "@/server/webhooks/dispatcher";
import { emitEvent } from "@/server/webhooks/events";

import { json, params, request, setupServer, signIn } from "./helpers/env";
import { merchantWithKeys } from "./helpers/flows";

/**
 * One merchant's slow or broken endpoint must not hold up everyone else's
 * webhooks: the dispatcher serves each endpoint from one worker, one delivery
 * at a time, and stops on an endpoint for the pass once it fails.
 */

beforeEach(() => {
  setupServer();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the dispatcher isolates endpoints", () => {
  it("a slow, failing endpoint gets one attempt per pass, and doesn't delay another merchant's delivery", async () => {
    const slow = await merchantWithKeys({ webhook: true }); // http://127.0.0.1:3531/webhook
    const fast = await merchantWithKeys();
    signIn({ userId: fast.userId, walletAddress: fast.account.address });
    const hook = await json(await createWebhook(request("POST", "/api/webhooks", { body: { url: "http://127.0.0.1:3532/fast", events: ["payment.succeeded"] } }), params({})));
    expect(hook.status).toBe(201);

    const slowRecord = (await getDb().merchants.get(slow.userId))!;
    const fastRecord = (await getDb().merchants.get(fast.userId))!;
    for (let i = 0; i < 6; i++) await emitEvent({ merchant: slowRecord, type: "payment.succeeded", data: { i }, sourceKey: `0xslow:${i}:payment.succeeded` });
    await emitEvent({ merchant: fastRecord, type: "payment.succeeded", data: { fast: true }, sourceKey: "0xfast:0:payment.succeeded" });

    const calls: string[] = [];
    let fastDeliveredAtMs = 0;
    const started = Date.now();
    configureDispatcherForTests({
      transport: async (url) => {
        calls.push(url.pathname);
        if (url.pathname === "/webhook") {
          await sleep(300); // a hanging endpoint, cut off at its timeout
          return { status: 504, body: "" };
        }
        fastDeliveredAtMs = Date.now() - started;
        return { status: 200, body: "ok" };
      },
    });

    const summary = await dispatchDue();
    expect(summary).toMatchObject({ attempted: 2, succeeded: 1, retrying: 1 });
    expect(calls.filter((p) => p === "/webhook")).toHaveLength(1);
    expect(fastDeliveredAtMs).toBeLessThan(250); // not queued behind the slow one
    // The slow endpoint's other five wait for a later pass, untouched.
    const pending = await getDb().webhookDeliveries.find({ state: "pending" });
    expect(pending.filter((d) => d.attempts.length === 0)).toHaveLength(5);
  });

  it("a healthy endpoint with a backlog is still served in order, a few per pass", async () => {
    const m = await merchantWithKeys({ webhook: true });
    const record = (await getDb().merchants.get(m.userId))!;
    for (let i = 0; i < 12; i++) await emitEvent({ merchant: record, type: "payment.succeeded", data: { i }, sourceKey: `0xbacklog:${i}:payment.succeeded` });
    configureDispatcherForTests({ transport: async () => ({ status: 200, body: "ok" }) });
    expect(await dispatchDue()).toMatchObject({ attempted: 10, succeeded: 10 });
    expect(await dispatchDue()).toMatchObject({ attempted: 2, succeeded: 2 });
  });
});
