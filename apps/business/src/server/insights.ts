import "server-only";

import { createIndexerClient, type Activity, type IndexerClient } from "@polarispay/indexer-client";
import { merchantVoice } from "@polarispay/underwriting/core";
import type { Address } from "viem";

import type { IndexedEvent, UnderwritingReason } from "@/lib/data/insights";
import type { Insights, Payment, Plan, WebhookEventType } from "@/lib/data/types";
import { getDb } from "./db";
import { getConfig } from "./env";

/**
 * The Overview's sponsor panels, from the services behind them:
 *
 * - "Indexed by Envio": the merchant's latest chain events from the Polaris
 *   Envio indexer (`@polarispay/indexer-client`, `merchantActivity`) when
 *   POLARIS_INDEXER_URL is set. Without it, the same kinds of events from this
 *   server's own chain sync, labelled as such; an unreachable indexer says so.
 * - "Why your buyers got credit": the reasons the CRE underwriting workflow's
 *   decisions carried for this merchant's Pay in 4 buyers (the facts the DON
 *   attested, explained by @polarispay/underwriting), each with its provider.
 */

let clientOverride: IndexerClient | null = null;

/** Tests: answer the indexer from a fake. */
export function setIndexerClientForTests(client: IndexerClient | null): void {
  clientOverride = client;
}

function indexerClient(): IndexerClient | null {
  if (clientOverride) return clientOverride;
  const { indexer, chain } = getConfig();
  if (!indexer.url) return null;
  return createIndexerClient({
    url: indexer.url,
    chainId: chain?.id,
    headers: indexer.token ? { authorization: `Bearer ${indexer.token}` } : undefined,
    // The Overview waits on it: an indexer that is down costs 2 s, not 5.
    timeoutMs: 2_000,
  });
}

/** The indexer's answer per merchant wallet, for 10 s: the Overview reads every few seconds. */
const indexerCache = new Map<string, { at: number; value: Promise<Insights["indexer"]> }>();
const INDEXER_CACHE_MS = 10_000;

const cents = (units: bigint) => Number(units / 10_000n);

function titleOf(a: Activity): string {
  const order = a.orderId ? `Order ${a.orderId}` : "A payment";
  switch (a.kind) {
    case "payment.succeeded":
      return order;
    case "plan.opened":
      return `${order}, Pay in ${a.installmentCount ?? 4}`;
    case "installment.collected":
    case "installment.failed":
      return `Plan ${a.refId}, instalment ${(a.installmentIndex ?? 0) + 1} of ${a.installmentCount ?? 4}`;
    case "plan.completed":
    case "plan.liquidated":
      return `Plan ${a.refId}`;
    case "subscription.charged":
    case "subscription.canceled":
      return `Subscription ${a.refId}`;
    case "payout.paid":
      return "Payout";
    default:
      return a.kind;
  }
}

export function eventFromActivity(a: Activity): IndexedEvent {
  return {
    id: a.id,
    type: a.kind as WebhookEventType,
    title: titleOf(a),
    amountCents: cents(a.amount),
    block: a.blockNumber,
    txHash: a.txHash,
    at: new Date(a.timestamp * 1000).toISOString(),
  };
}

/** The chain sync's own view of the same events, when no indexer is configured. */
function eventsFromSync(payments: Payment[], plans: Plan[]): IndexedEvent[] {
  const events: IndexedEvent[] = [];
  for (const p of payments) {
    if (p.status !== "succeeded" || !p.txHash) continue;
    const type: WebhookEventType = p.mode === "later" ? "plan.opened" : p.mode === "subscribe" ? "subscription.charged" : "payment.succeeded";
    events.push({ id: `${p.id}:${type}`, type, title: p.description, amountCents: p.amountCents, block: 0, txHash: p.txHash, at: p.createdAt });
  }
  for (const plan of plans) {
    if (plan.installmentsPaid === 0) continue;
    events.push({
      id: `${plan.id}:paid:${plan.installmentsPaid}`,
      type: plan.state === "repaid" ? "plan.completed" : "installment.collected",
      title: `${plan.description}, ${plan.installmentsPaid} of ${plan.installmentCount} paid`,
      amountCents: Math.floor(plan.totalCents / plan.installmentCount),
      block: 0,
      txHash: "",
      at: plan.openedAt,
    });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}

async function indexedEvents(wallet: Address | null, payments: Payment[], plans: Plan[]): Promise<Insights["indexer"]> {
  const client = indexerClient();
  if (!client) return { source: "chain-sync", events: eventsFromSync(payments, plans) };
  if (!wallet) return { source: "envio", events: [], progressBlock: null };
  const key = wallet.toLowerCase();
  const hit = indexerCache.get(key);
  if (!clientOverride && hit && Date.now() - hit.at < INDEXER_CACHE_MS) return hit.value;
  const value = (async (): Promise<Insights["indexer"]> => {
    try {
      const [activity, status] = await Promise.all([client.merchantActivity(wallet, { limit: 8 }), client.status().catch(() => null)]);
      return { source: "envio", events: activity.map(eventFromActivity), progressBlock: status?.progressBlock ?? null };
    } catch (error) {
      // The detail is for the server's log; the dashboard says it plainly.
      console.warn(`[insights] the Envio indexer didn't answer: ${error instanceof Error ? error.message : String(error)}`);
      return { source: "envio-error", error: "The indexer didn't answer." };
    }
  })();
  indexerCache.set(key, { at: Date.now(), value });
  return value;
}

const PROVIDER_LABEL: Record<string, UnderwritingReason["source"]> = { nansen: "Nansen", zerion: "Zerion" };

/** The reasons behind this merchant's buyers' lines, strongest first, from the CRE decisions. */
async function underwritingReasons(plans: Plan[]): Promise<Insights["underwriting"]> {
  const buyers = [...new Set(plans.map((p) => p.buyer.toLowerCase()))].slice(0, 200);
  if (buyers.length === 0) return null;
  const db = getDb();
  const tally = new Map<string, UnderwritingReason & { count: number }>();
  let decided = 0;
  let lineCents = 0;
  const decisions = await Promise.all(buyers.map((buyer) => db.creditDecisions.get(buyer)));
  for (const decision of decisions) {
    const reasons = decision?.status === "applied" ? (decision.explanation?.reasons ?? []) : [];
    if (reasons.length === 0) continue;
    decided++;
    const limit = decision?.explanation?.limitUnits;
    if (limit && /^\d+$/.test(limit)) lineCents += cents(BigInt(limit));
    for (const r of reasons) {
      if (r.points === null || r.points <= 0) continue;
      // The buyer's line, told to the merchant: "Buyer's linked account in use for 3 years".
      const text = merchantVoice(r.text.replace(/ · [+\-−]?\d+$/, ""));
      const prev = tally.get(text);
      tally.set(text, {
        text,
        points: Math.max(prev?.points ?? 0, r.points),
        // The provider, when the explanation knows it (attributed facts); the chain carries only the facts.
        source: PROVIDER_LABEL[r.provider ?? ""] ?? null,
        count: (prev?.count ?? 0) + 1,
      });
    }
  }
  if (decided === 0) return null;
  const reasons = [...tally.values()].sort((a, b) => b.count - a.count || b.points - a.points).map((r) => ({ text: r.text, points: r.points, source: r.source }));
  return { buyers: decided, reasons, averageLineCents: Math.round(lineCents / decided) };
}

export async function merchantInsights(input: { wallet: Address | null; payments: Payment[]; plans: Plan[] }): Promise<Insights | undefined> {
  const [indexer, underwriting] = await Promise.all([indexedEvents(input.wallet, input.payments, input.plans), underwritingReasons(input.plans)]);
  return { indexer, underwriting };
}
