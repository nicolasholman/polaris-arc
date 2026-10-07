import { describe, expect, it } from "vitest";

import { POST as createKey } from "@/app/api/keys/route";
import { POST as createWebhook } from "@/app/api/webhooks/route";
import { getDb } from "@/server/db";
import { outboxHealth, pollIndexerOutbox } from "@/server/webhooks/outbox";

import { validateWebhookEvent } from "../../../packages/sdk/src/event-shape";
import { json, params, request, setupServer, signIn } from "./helpers/env";

/**
 * The webhook dispatcher's outbox reader against a running indexer, not a
 * fake: POLARIS_INDEXER_URL through getConfig() to the real client, the
 * indexer's own Activity rows, this server's emitEvent. Opt in with
 *
 *   POLARIS_INDEXER_LIVE_URL       the indexer's GraphQL endpoint, e.g. `pnpm indexer:local`'s
 *                                  http://127.0.0.1:18080/v1/graphql
 *   POLARIS_INDEXER_LIVE_MERCHANT  a merchant wallet it has indexed events for
 *                                  (a local deployment's demo.merchant)
 *
 * Skipped otherwise. The indexed chain must be 31337, the fixture
 * deployment's. Payout rows are skipped here (this store made no payouts).
 */

const URL = process.env.POLARIS_INDEXER_LIVE_URL;
const MERCHANT = process.env.POLARIS_INDEXER_LIVE_MERCHANT;

describe.skipIf(!URL || !MERCHANT)("the webhook outbox, read from a live indexer", () => {
  it("turns every one of the merchant's rows into a valid event once, and resumes from its cursor", async () => {
    setupServer({ POLARIS_INDEXER_URL: URL as string, POLARIS_SYNC_FROM_BLOCK: "0" });
    signIn({ userId: "did:privy:live-outbox", walletAddress: MERCHANT as `0x${string}`, walletId: "wal_live" });
    expect((await createKey(request("POST", "/api/keys", { body: { name: "Server" } }), params({}))).status).toBe(201);
    const hook = await json(
      await createWebhook(
        request("POST", "/api/webhooks", {
          body: {
            url: "http://127.0.0.1:3531/webhook",
            events: ["payment.succeeded", "plan.opened", "installment.collected", "installment.failed", "plan.completed", "plan.liquidated", "subscription.charged", "subscription.canceled", "payout.paid"],
          },
        }),
        params({}),
      ),
    );
    expect(hook.status).toBe(201);

    const first = await pollIndexerOutbox({ pages: 1_000 });
    expect(first?.error).toBeUndefined();
    expect(first?.caughtUp).toBe(true);
    expect(first?.rejected).toBe(0);
    expect(first?.emitted).toBeGreaterThan(0);

    const events = await getDb().webhookEvents.find({});
    expect(events).toHaveLength(first?.emitted as number);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const e of events) {
      expect(e.source).toBe("indexer");
      expect(validateWebhookEvent(JSON.parse(e.body)), e.type).toEqual([]);
    }
    expect(await getDb().webhookDeliveries.find({})).toHaveLength(events.length);
    const kinds = [...new Set(events.map((e) => e.type))].sort();
    console.log(`[outbox.live] read ${first?.read} rows to cursor ${first?.cursor}: ${first?.emitted} events (${kinds.join(", ")}), ${first?.skipped} skipped`);

    // Resumes: nothing new after the cursor.
    expect(await pollIndexerOutbox()).toMatchObject({ read: 0, emitted: 0 });
    // Read again from the start: every id is taken, nothing is queued twice.
    await getDb().indexerOutbox.update("activity", (s) => ({ ...s, cursor: "-1" }));
    expect(await pollIndexerOutbox({ pages: 1_000 })).toMatchObject({ emitted: 0, duplicates: first?.emitted });
    expect(await getDb().webhookDeliveries.find({})).toHaveLength(events.length);
    expect(await outboxHealth()).toMatchObject({ mode: "indexer", problem: null });
  });
});
