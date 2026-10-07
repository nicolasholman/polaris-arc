import "server-only";

import type { CreRunRecord, MerchantRecord, PlanRecord } from "@polaris/db";
import { formatUnits, getAddress, type Address } from "viem";

import type { KeeperJob, KeeperOverview, KeeperRun, WorkflowKey, WorkflowTrigger } from "@/lib/data/keeper";

import { publicClient } from "../chain/client";
import { getDb } from "../db";
import { explorerTxUrl, getConfig, type ChainConfig } from "../env";
import { creditGuard, describeGuard } from "./guard";

/**
 * The dashboard's Automation page, from the chain: the keeper's reports (the
 * receivers' events, recorded by the chain sync in `cre_runs`), the keeper's
 * own address and gas balance, and the credit guard.
 */

const RUNS_SHOWN = 8;

const JOBS: Record<WorkflowKey, { name: string; role: string }> = {
  collections: {
    name: "Collections",
    role: "Collects due Pay in 4 instalments and subscription renewals, retries a buyer the moment they sign again, and closes plans past their last chance.",
  },
  underwrite: {
    name: "Credit reviews",
    role: "Reads a buyer's history (their Arc account, and a wallet they link from another chain) and writes the facts to ScoreManager, which scores them on chain.",
  },
};

function triggersFor(key: WorkflowKey): WorkflowTrigger[] {
  const every = Number(process.env.KEEPER_COLLECTIONS_INTERVAL_SECONDS ?? 60);
  switch (key) {
    case "collections":
      return [
        { kind: "timer", label: "Timer", detail: every === 60 ? "Every minute" : `Every ${every} s` },
        { kind: "evm-log", label: "Event", detail: "Reauthorized on PolarisCheckout: collects the buyer's due instalments at once" },
      ];
    case "underwrite":
      return [
        {
          kind: "http",
          label: "Request",
          detail: getConfig().keeper.underwritingUrl
            ? "Raise your limit in the app: the buyer's signed consent, queued by this server"
            : "Raise your limit in the app (KEEPER_UNDERWRITING_URL isn't set on this server)",
        },
      ];
  }
}

const sum = (values: Array<string | null>) => values.reduce((s, v) => s + BigInt(v ?? "0"), 0n).toString();

export function runView(
  record: CreRunRecord,
  mine: { plans: Map<string, PlanRecord>; buyers: Set<string> },
  explorer: (hash: string) => string | null,
): KeeperRun {
  const run: KeeperRun = {
    txHash: record.txHash,
    explorerUrl: explorer(record.txHash),
    blockNumber: record.blockNumber,
    at: record.at,
    sender: record.delivery?.transmitter ?? null,
  };
  if (record.collections) {
    const c = record.collections;
    const collectedItems = c.items.filter((i) => i.executed && i.action === 1);
    const yoursCollected = collectedItems.filter((i) => mine.plans.has(i.id));
    const skippedBy: Record<string, number> = {};
    for (const i of c.items) if (!i.executed) skippedBy[i.reason ?? "other"] = (skippedBy[i.reason ?? "other"] ?? 0) + 1;
    const origin = c.afterReauthorization;
    run.collections = {
      tasks: c.tasks,
      executed: c.executed,
      skipped: c.skipped,
      collected: collectedItems.length,
      collectedUnits: sum(collectedItems.map((i) => i.amountUnits)),
      charged: c.items.filter((i) => i.executed && i.action === 2).length,
      liquidated: c.items.filter((i) => i.executed && i.action === 3).length,
      skippedBy,
      yours: {
        collected: yoursCollected.length,
        collectedUnits: sum(yoursCollected.map((i) => i.amountUnits)),
        dunned: c.items.filter((i) => !i.executed && i.action === 1 && mine.plans.has(i.id)).length,
      },
      afterReauthorization: origin
        ? {
            txHash: origin.txHash,
            explorerUrl: explorer(origin.txHash),
            at: origin.at,
            seconds: Math.max(0, Math.round((Date.parse(record.at) - Date.parse(origin.at)) / 1000)),
            yours: mine.buyers.has(origin.buyer.toLowerCase()),
          }
        : null,
    };
  }
  if (record.underwrite) {
    const items = record.underwrite.items;
    run.underwrite = {
      applied: items.filter((i) => i.applied).length,
      refused: items.filter((i) => !i.applied).length,
      items: items.map((i) => ({ applied: i.applied, score: i.score, reason: i.reason, buyer: mine.buyers.has(i.user.toLowerCase()) ? i.user : null })),
    };
  }
  return run;
}

async function keeperOf(chain: ChainConfig): Promise<KeeperOverview["keeper"]> {
  const address = chain.keeper?.address ? getAddress(chain.keeper.address) : null;
  let gasUsdc: string | null = null;
  if (address) {
    try {
      gasUsdc = formatUnits(await publicClient().getBalance({ address }), 18);
    } catch {
      gasUsdc = null;
    }
  }
  const heartbeat = await getDb().collectorRuns.get("cre");
  return {
    address,
    addressUrl: address && chain.explorerUrl ? `${chain.explorerUrl}/address/${address}` : null,
    gasUsdc,
    lastHeartbeatAt: heartbeat?.lastRunAt ?? null,
    reviewsOpen: Boolean(getConfig().keeper.underwritingUrl),
  };
}

export async function keeperOverview(merchant: MerchantRecord): Promise<KeeperOverview> {
  const config = getConfig();
  const chain = config.chain;
  const now = Date.now();
  if (!chain) {
    return {
      deployed: false,
      network: null,
      keeper: { address: null, addressUrl: null, gasUsdc: null, lastHeartbeatAt: null, reviewsOpen: false },
      workflows: [],
      guard: describeGuard(null, { contracts: { guardian: null } as ChainConfig["contracts"] }, new Date(now)),
      readAt: new Date(now).toISOString(),
    };
  }
  const db = getDb();
  const plans = await db.plans.find({ merchantId: merchant.id });
  const mine = { plans: new Map(plans.map((p) => [p.id, p])), buyers: new Set(plans.map((p) => p.borrower.toLowerCase())) };
  const explorer = (hash: string) => explorerTxUrl(hash, config);
  const since = new Date(now - 86_400_000).toISOString();
  const receivers: Record<WorkflowKey, Address | null> = { collections: chain.contracts.collections, underwrite: chain.contracts.underwriting };

  const [guard, keeper, ...workflows] = await Promise.all([
    creditGuard(),
    keeperOf(chain),
    ...(Object.keys(JOBS) as WorkflowKey[]).map(async (key): Promise<KeeperJob> => {
      const [records, runs24h] = await Promise.all([
        db.creRuns.find({ workflow: key }, { orderBy: "at", direction: "desc", limit: RUNS_SHOWN }),
        db.creRuns.count({ workflow: key, at: { gte: since } }),
      ]);
      const receiver = receivers[key];
      return {
        key,
        name: JOBS[key].name,
        role: JOBS[key].role,
        receiver: receiver ? getAddress(receiver) : null,
        receiverUrl: receiver && chain.explorerUrl ? `${chain.explorerUrl}/address/${receiver}` : null,
        triggers: triggersFor(key),
        runs: records.map((r) => runView(r, mine, explorer)),
        runs24h,
        lastRunAt: records[0]?.at ?? null,
      };
    }),
  ]);

  return {
    deployed: true,
    network: { chainId: chain.id, name: chain.name, explorerUrl: chain.explorerUrl || null },
    keeper,
    workflows,
    guard,
    readAt: new Date(now).toISOString(),
  };
}
