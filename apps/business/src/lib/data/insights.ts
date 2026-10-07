import type { Cents, CollectorStatus, Insights, IsoDate, Plan, WebhookEventType } from "./types";

/**
 * The sponsor-backed panels on the Overview, behind one typed function each:
 *
 * | Panel | Service | Function |
 * |---|---|---|
 * | Collections | Chainlink CRE `collections` workflow | `getCollectionsRun` |
 * | Indexed events | Envio HyperIndex on Monad | `getIndexedEvents` |
 * | Credit exposure reasons | Nansen wallet history (underwriting) | `getUnderwritingReasons` |
 *
 * The collections workflow's runs reach this server through the chain sync
 * (its heartbeat is `Overview.collector`); the indexer feed and the
 * underwriting reasons come with the Overview (`Overview.insights`, built by
 * server/insights.ts from @polarispay/indexer-client and the CRE decisions).
 * Each function returns `{ source: "live" }` with `via` naming where the
 * data came from when it isn't the service itself, or
 * `{ source: "not_connected" }` with the reason when the service is silent,
 * so the panel says so instead of showing anything invented.
 */

export type Sourced<T> =
  | { source: "live"; data: T; via?: "chain-sync" }
  | { source: "not_connected"; reason: string };

const MINUTE = 60_000;

/* ── Chainlink CRE: the collections workflow ────────────────────────────── */

export type CollectionsRun = {
  workflow: string;
  /** When it runs, in words. */
  schedule: string;
  /** running: reported in the last 5 minutes; degraded: in the last hour; stopped: older. */
  state: CollectorStatus["state"];
  lastRun: {
    at: IsoDate;
    /** Plans the workflow looked at. */
    checked: number;
    /** Instalments it collected, when the run reported them. */
    collected: number | null;
    collectedCents: Cents | null;
    /** Collections that failed and entered the retry ladder. */
    retrying: number;
    /** Why items were skipped, in the words the merchant sees. */
    skipped: { reason: string; count: number }[];
  };
  nextRunAt: IsoDate;
  /** The last few runs, oldest first: instalments collected per run. */
  history: number[];
};

/** The collections card, from collectorStatus in server/services.ts (the chain's CollectionsRun events and the CRE runner's heartbeat). */
export function getCollectionsRun({ plans, collector }: { plans: Plan[]; collector?: CollectorStatus }): Sourced<CollectionsRun> {
  if (collector?.lastPassAt) {
    // The workflow's last report to this server. It runs every minute.
    const open = plans.filter((p) => p.state === "collecting" || p.state === "dunning");
    const retrying = plans.filter((p) => p.state === "dunning").length;
    return {
      source: "live",
      data: {
        workflow: "polaris-collections",
        schedule: "Every minute",
        state: collector.state,
        lastRun: { at: collector.lastPassAt, checked: open.length, collected: null, collectedCents: null, retrying, skipped: [] },
        nextRunAt: new Date(Date.parse(collector.lastPassAt) + MINUTE).toISOString(),
        history: [],
      },
    };
  }
  return {
    source: "not_connected",
    reason: "The collections workflow runs on Chainlink CRE every minute once it's deployed. Its runs appear here when it starts reporting.",
  };
}

/* ── Envio: indexed chain events ────────────────────────────────────────── */

export type IndexedEvent = {
  id: string;
  type: WebhookEventType;
  /** What happened, in words: "Brand identity package". */
  title: string;
  amountCents: Cents;
  block: number;
  txHash: string;
  at: IsoDate;
};

/** The indexed-events feed, from server/insights.ts (the Envio indexer, or the chain sync). */
export function getIndexedEvents({ insights }: { insights?: Insights }): Sourced<IndexedEvent[]> {
  const feed = insights?.indexer;
  if (feed?.source === "envio") return { source: "live", data: feed.events };
  if (feed?.source === "chain-sync" && feed.events.length) return { source: "live", data: feed.events, via: "chain-sync" };
  if (feed?.source === "envio-error") {
    return { source: "not_connected", reason: `The Envio indexer didn't answer (${feed.error}). Your payments and plans still come straight from Monad, through this server's own chain sync.` };
  }
  return {
    source: "not_connected",
    reason: "The Envio indexer for Polaris isn't connected to this server (POLARIS_INDEXER_URL). Your payments and plans already come straight from Monad, through this server's own chain sync.",
  };
}

/* ── Nansen: why buyers got credit ──────────────────────────────────────── */

export type UnderwritingReason = {
  /** Plain language, as the buyer sees it in the app. */
  text: string;
  /** Points toward the score (negative lowers it). */
  points: number;
  /** Where the fact came from. */
  source: "Nansen" | "Zerion" | "Polaris" | null;
};

export type Underwriting = {
  /** Buyers underwritten for plans still open. */
  buyers: number;
  /** The reasons that moved those decisions most, strongest first. */
  reasons: UnderwritingReason[];
  /** Plans opened on a line below the $1,000 starting cap. */
  averageLineCents: Cents;
};

/** Why buyers got credit, from server/insights.ts (the CRE underwriting decisions). */
export function getUnderwritingReasons({ insights }: { insights?: Insights }): Sourced<Underwriting> {
  if (insights?.underwriting) return { source: "live", data: insights.underwriting };
  return {
    source: "not_connected",
    reason: "When a buyer picks Pay in 4, Chainlink CRE nodes fetch their wallet history from Nansen and the score is computed on chain. The reasons behind your buyers' lines show here once underwriting reports.",
  };
}
