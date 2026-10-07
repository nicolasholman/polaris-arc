import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CreRunRecord, MerchantRecord, PlanRecord } from "@polaris/db";
import { getAddress, type Address, type Hex } from "viem";

import type { ChainlinkOverview, ChainlinkRun, ChainlinkWorkflow, WorkflowKey, WorkflowTrigger } from "@/lib/data/chainlink";
import { describeCron, nextCronFire } from "@/lib/data/cron";
import { reasonsFromMask } from "@/lib/data/guard";

import { getDb } from "../db";
import { explorerTxUrl, getConfig, type ChainConfig } from "../env";
import { creditGuard } from "./guardian";
import { forwarderKindOf } from "./provenance";

/**
 * The dashboard's Chainlink page: each CRE workflow, its triggers, and what
 * its latest reports did on chain (recorded by the chain sync, ingest/cre.ts),
 * with the credit guard read now. Protocol-wide, as the chain is, but a
 * merchant only sees its own buyers' addresses and its own share of each
 * collections run.
 */

const RUNS_SHOWN = 8;

/** The workflows' folders under workflows/, and the name each is deployed under. */
const WORKFLOWS: Record<WorkflowKey, { dir: string; name: string; role: string }> = {
  collections: {
    dir: "collections",
    name: "polaris-collections",
    role: "Collects due Pay in 4 instalments and subscription renewals, and closes plans past their last chance.",
  },
  underwrite: {
    dir: "underwriting",
    name: "polaris-underwrite",
    role: "Reads a buyer's wallet history (Nansen, Zerion, Etherscan, the chain), agrees on the facts and writes them to ScoreManager.",
  },
  guardian: {
    dir: "guardian",
    name: "polaris-guardian",
    role: "Reads Chainlink's AUSD/USD on Monad mainnet and the credit pool on Monad testnet, and pauses new Pay in 4 plans when either is unhealthy.",
  },
};

/**
 * A workflow's cron schedule, from its own config (workflows/<dir>/config.<target>.json,
 * `schedule`). The target is CRE_TARGET (staging, the simulate-on-testnet
 * settings, by default; production once deployed).
 */
export function workflowSchedule(dir: string, target = process.env.CRE_TARGET?.trim() || "staging"): string | null {
  const cwd = process.cwd();
  const candidates = [
    join(/*turbopackIgnore: true*/ cwd, "..", "..", "workflows", dir, `config.${target}.json`),
    join(/*turbopackIgnore: true*/ cwd, "workflows", dir, `config.${target}.json`),
  ];
  const file = candidates.find((p) => existsSync(/*turbopackIgnore: true*/ p));
  if (!file) return null;
  try {
    const config = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as { schedule?: unknown };
    return typeof config.schedule === "string" ? config.schedule : null;
  } catch {
    return null;
  }
}

function cronTrigger(schedule: string | null, now: number): WorkflowTrigger {
  if (!schedule) return { kind: "cron", label: "Cron", detail: "Schedule not configured", schedule: null, nextAt: null };
  const next = nextCronFire(schedule, now);
  return { kind: "cron", label: "Cron", detail: describeCron(schedule), schedule, nextAt: next ? new Date(next).toISOString() : null };
}

function triggersFor(key: WorkflowKey, chain: ChainConfig, now: number): WorkflowTrigger[] {
  const cre = chain.cre?.workflows;
  switch (key) {
    case "collections": {
      const retry = cre?.collections?.retry;
      return [
        cronTrigger(workflowSchedule(WORKFLOWS.collections.dir), now),
        {
          kind: "evm-log",
          label: "EVM log",
          detail: `Reauthorized on PolarisCheckout${retry?.contract ? ` (${shortAddress(retry.contract)})` : ""}: collects the buyer's due instalments at once`,
        },
      ];
    }
    case "underwrite":
      return [
        {
          kind: "http",
          label: "HTTP",
          detail: getConfig().cre.underwritingTriggerUrl
            ? "Raise your limit in the app: the buyer's signed consent, queued by this server"
            : "Raise your limit in the app (the trigger URL isn't set on this server)",
        },
      ];
    case "guardian":
      return [cronTrigger(workflowSchedule(WORKFLOWS.guardian.dir), now)];
  }
}

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const sum = (values: Array<string | null>) => values.reduce((s, v) => s + BigInt(v ?? "0"), 0n).toString();

/** One run record, in the page's terms, with the merchant's own share. */
export function runView(
  record: CreRunRecord,
  mine: { plans: Map<string, PlanRecord>; buyers: Set<string> },
  explorer: (hash: string) => string | null,
): ChainlinkRun {
  const run: ChainlinkRun = {
    txHash: record.txHash,
    explorerUrl: explorer(record.txHash),
    blockNumber: record.blockNumber,
    at: record.at,
    delivery: record.delivery
      ? {
          forwarder: record.delivery.forwarder,
          transmitter: record.delivery.transmitter,
          workflowExecutionId: record.delivery.workflowExecutionId,
          result: record.delivery.result,
        }
      : null,
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
      items: items.map((i) => ({
        applied: i.applied,
        score: i.score,
        reason: i.reason,
        buyer: mine.buyers.has(i.user.toLowerCase()) ? i.user : null,
      })),
    };
  }
  if (record.guardian) {
    const g = record.guardian;
    run.guardian = {
      accepted: g.accepted,
      round: g.round,
      creditPaused: g.creditPaused,
      reasons: g.reasons === null ? [] : reasonsFromMask(g.reasons),
      price: g.price === null ? null : (Number(g.price) / 1e8).toFixed(4),
      priceRoundId: g.priceRoundId,
      freeCashUnits: g.freeCashUnits,
      observedAt: g.observedAt,
      refusal: g.refusal,
    };
  }
  return run;
}

export async function chainlinkOverview(merchant: MerchantRecord): Promise<ChainlinkOverview> {
  const config = getConfig();
  const chain = config.chain;
  const now = Date.now();
  if (!chain) {
    return {
      deployed: false,
      network: null,
      delivery: { forwarderKind: null, forwarder: null, locked: false, workflowOwner: null },
      workflows: [],
      guard: {
        state: "unconfigured",
        paused: false,
        reasons: [],
        message: null,
        checkedAt: null,
        ageSeconds: null,
        maxAgeSeconds: null,
        override: "none",
        overrideUntil: null,
        guardian: null,
        mismatch: null,
        round: null,
        readAt: new Date(now).toISOString(),
        attested: null,
        sources: null,
        thresholds: null,
        pool: null,
        attestation: null,
        checks: [],
        feed: null,
        priceFeed: null,
      },
      readAt: new Date(now).toISOString(),
    };
  }
  const db = getDb();
  const plans = await db.plans.find({ merchantId: merchant.id });
  const mine = { plans: new Map(plans.map((p) => [p.id, p])), buyers: new Set(plans.map((p) => p.borrower.toLowerCase())) };
  const explorer = (hash: string) => explorerTxUrl(hash, config);
  const since = new Date(now - 86_400_000).toISOString();
  const receivers: Record<WorkflowKey, Address | null> = {
    collections: chain.contracts.collections,
    underwrite: chain.contracts.underwriting,
    guardian: chain.contracts.guardian,
  };

  const [guard, ...workflows] = await Promise.all([
    creditGuard(),
    ...(Object.keys(WORKFLOWS) as WorkflowKey[]).map(async (key): Promise<ChainlinkWorkflow> => {
      const [records, runs24h] = await Promise.all([
        db.creRuns.find({ workflow: key }, { orderBy: "at", direction: "desc", limit: RUNS_SHOWN }),
        db.creRuns.count({ workflow: key, at: { gte: since } }),
      ]);
      const receiver = receivers[key];
      const recorded = chain.cre?.workflows?.[key];
      return {
        key,
        name: recorded?.name ?? WORKFLOWS[key].name,
        role: WORKFLOWS[key].role,
        receiver: receiver ? getAddress(receiver) : null,
        receiverUrl: receiver && chain.explorerUrl ? `${chain.explorerUrl}/address/${receiver}` : null,
        workflowId: (recorded?.workflowId as Hex | undefined) ?? null,
        triggers: triggersFor(key, chain, now),
        runs: records.map((r) => runView(r, mine, explorer)),
        runs24h,
        lastRunAt: records[0]?.at ?? null,
      };
    }),
  ]);

  const cre = chain.cre;
  return {
    deployed: true,
    network: { chainId: chain.id, name: chain.name, explorerUrl: chain.explorerUrl || null },
    delivery: {
      forwarderKind: forwarderKindOf(cre?.forwarderKind, chain),
      forwarder: cre?.forwarder ? getAddress(cre.forwarder) : null,
      locked: Boolean(cre?.locked),
      workflowOwner: cre?.locked?.workflowOwner ?? cre?.workflowOwner ?? null,
    },
    workflows,
    guard,
    readAt: new Date(now).toISOString(),
  };
}
