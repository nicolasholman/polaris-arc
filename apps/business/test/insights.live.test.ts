import { describe, expect, it } from "vitest";

import { getIndexedEvents } from "@/lib/data/insights";
import { merchantInsights } from "@/server/insights";

import { setupServer } from "./helpers/env";

/**
 * The Overview's Envio panel against a running indexer, not a fake: the same
 * path as production, POLARIS_INDEXER_URL through getConfig() to
 * @polarispay/indexer-client's merchantActivity and status. Opt in with
 *
 *   POLARIS_INDEXER_LIVE_URL       the indexer's GraphQL endpoint, e.g. `pnpm indexer:local`'s
 *                                  http://127.0.0.1:18080/v1/graphql
 *   POLARIS_INDEXER_LIVE_MERCHANT  a merchant wallet it has indexed payments for
 *                                  (a local deployment's demo.merchant)
 *
 * Skipped otherwise. The indexed chain must be 31337, the fixture
 * deployment's, for the progress block to be read.
 */

const URL = process.env.POLARIS_INDEXER_LIVE_URL;
const MERCHANT = process.env.POLARIS_INDEXER_LIVE_MERCHANT;
const WEBHOOK_KINDS = [
  "payment.succeeded",
  "plan.opened",
  "installment.collected",
  "installment.failed",
  "plan.completed",
  "plan.liquidated",
  "subscription.charged",
  "subscription.canceled",
  "payout.paid",
];

describe.skipIf(!URL || !MERCHANT)("the Envio panel, read from a live indexer", () => {
  it("shows the merchant's indexed events and the indexer's progress", async () => {
    setupServer({ POLARIS_INDEXER_URL: URL as string });
    const insights = await merchantInsights({ wallet: MERCHANT as `0x${string}`, payments: [], plans: [] });
    const indexer = insights?.indexer;
    expect(indexer?.source).toBe("envio");
    if (indexer?.source !== "envio") return;
    expect(indexer.progressBlock).toBeGreaterThan(0);
    expect(indexer.events.length).toBeGreaterThan(0);
    for (const e of indexer.events) {
      expect(WEBHOOK_KINDS).toContain(e.type);
      expect(e.block).toBeGreaterThan(0);
      expect(e.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
    // Newest first, as the Overview lists them.
    const blocks = indexer.events.map((e) => e.block);
    expect(blocks).toEqual([...blocks].sort((a, b) => b - a));

    const feed = getIndexedEvents({ insights });
    expect(feed.source).toBe("live");
  });
});
