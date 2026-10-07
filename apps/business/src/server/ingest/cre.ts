import "server-only";

import { isDuplicateKeyError, type CreRunRecord, type CreTaskOutcome } from "@polaris/db";
import { mockKeystoneForwarderAbi } from "@polarispay/contracts/abi";
import { decodeErrorResult, decodeEventLog, getAddress, type Abi, type Address, type Hex, type Log } from "viem";

import { guardianReceiverAbi, underwritingReceiverAbi } from "../chain/abis";
import { publicClient } from "../chain/client";
import { decodeRevert, failureReasonOf } from "../chain/errors";
import { getDb } from "../db";

/**
 * What each Chainlink CRE report did, from the receivers' own events, for
 * the dashboard's Chainlink page (`GET /api/chainlink`):
 *
 * - polaris-collections: `CollectionsRun` with the `TaskExecuted` and
 *   `TaskSkipped` beside it in the same transaction;
 * - polaris-underwrite: `UnderwritingApplied` / `UnderwritingRefused`;
 * - polaris-guardian: `CreditGuardUpdated` / `AttestationRefused`;
 * - and PolarisCheckout's `Reauthorized`, the event the collections
 *   workflow's EVM log trigger listens for, so a run that collects a buyer
 *   right after they re-signed is shown with the event that preceded it.
 *
 * One record per report transaction (`cre_runs`). Where a receipt can be
 * read, the forwarder's `ReportProcessed` says which execution delivered it
 * and the transaction says who sent it (a DON node, or the simulation
 * transmitter under `cre workflow simulate --broadcast`).
 */

/** A decoded log, as ingest.ts hands it over. */
export type CreLog = {
  contract: string;
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
};

const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v));

/** How long after a buyer's Reauthorized a run that collects them counts as the retry it triggered. */
export const RETRY_WINDOW_MS = 15 * 60_000;

async function delivery(txHash: Hex, receiver: Address): Promise<CreRunRecord["delivery"]> {
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash: txHash });
    for (const log of receipt.logs as Log[]) {
      try {
        const out = decodeEventLog({ abi: mockKeystoneForwarderAbi as unknown as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (out.eventName !== "ReportProcessed") continue;
        const args = out.args as unknown as { receiver: Address; workflowExecutionId: Hex; result: boolean };
        if (getAddress(args.receiver) !== getAddress(receiver)) continue;
        return {
          forwarder: getAddress(log.address),
          transmitter: receipt.from ? getAddress(receipt.from) : null,
          workflowExecutionId: args.workflowExecutionId,
          result: Boolean(args.result),
        };
      } catch {
        // not the forwarder's event
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function upsertRun(id: string, create: () => Promise<CreRunRecord>, merge: (r: CreRunRecord) => CreRunRecord): Promise<void> {
  const db = getDb();
  const updated = await db.creRuns.update(id, merge);
  if (updated) return;
  try {
    await db.creRuns.insert(merge(await create()));
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    await db.creRuns.update(id, merge);
  }
}

function base(log: CreLog, at: string, workflow: CreRunRecord["workflow"]) {
  return async (): Promise<CreRunRecord> => ({
    id: log.txHash.toLowerCase(),
    workflow,
    txHash: log.txHash,
    blockNumber: log.blockNumber,
    at,
    delivery: await delivery(log.txHash, log.address),
  });
}

/** `PolarisCheckout.Reauthorized`: kept, and marked on the buyer's plans that failed for a lost approval. */
export async function onReauthorized(log: CreLog, at: string): Promise<void> {
  const db = getDb();
  const buyer = getAddress(log.args.buyer as string);
  try {
    await db.reauthorizations.insert({
      id: `${log.txHash}:${log.logIndex}`,
      buyer,
      valueUnits: str(log.args.value),
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      at,
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
  const plans = await db.plans.find({ borrower: buyer.toLowerCase(), state: "dunning" });
  for (const plan of plans) {
    if (plan.lastFailure?.reason !== "allowance_lost") continue;
    await db.plans.update(plan.id, (p) => ({ ...p, reauthorized: { at, txHash: log.txHash, collected: null }, updatedAt: at }));
  }
}

/** `CollectionsReceiver.CollectionsRun`, with the tasks the same transaction reported. */
export async function onCollectionsReport(log: CreLog, at: string, tx: readonly CreLog[]): Promise<void> {
  const items: CreTaskOutcome[] = [];
  for (const t of tx) {
    if (t.contract !== "collections") continue;
    if (t.eventName === "TaskExecuted") {
      items.push({ action: Number(t.args.action), id: str(t.args.id), executed: true, amountUnits: str(t.args.amount), reason: null });
    } else if (t.eventName === "TaskSkipped") {
      items.push({ action: Number(t.args.action), id: str(t.args.id), executed: false, amountUnits: null, reason: failureReasonOf(t.args.reason as Hex) });
    }
  }
  const afterReauthorization = await retryOrigin(items, at);
  await upsertRun(log.txHash.toLowerCase(), base(log, at, "collections"), (r) => ({
    ...r,
    collections: {
      tasks: Number(log.args.tasks),
      executed: Number(log.args.executed),
      skipped: Number(log.args.skipped),
      items,
      afterReauthorization,
    },
  }));
}

/** The latest Reauthorized, within RETRY_WINDOW_MS before `at`, of a borrower whose instalment this run collected. */
async function retryOrigin(items: CreTaskOutcome[], at: string): Promise<{ buyer: Address; txHash: Hex; at: string } | null> {
  const db = getDb();
  const runAt = Date.parse(at);
  const since = new Date(runAt - RETRY_WINDOW_MS).toISOString();
  let best: { buyer: Address; txHash: Hex; at: string } | null = null;
  for (const item of items) {
    if (!item.executed || item.action !== 1) continue;
    const plan = await db.plans.get(item.id);
    if (!plan) continue;
    const found = await db.reauthorizations.findOne({ buyer: plan.borrower.toLowerCase(), at: { gte: since, lte: at } }, { orderBy: "at", direction: "desc" });
    if (found && (!best || found.at > best.at)) best = { buyer: found.buyer, txHash: found.txHash, at: found.at };
  }
  return best;
}

function reasonName(data: Hex, abi: Abi): string {
  try {
    const out = decodeErrorResult({ abi, data });
    return out.errorName;
  } catch {
    return decodeRevert(data)?.name ?? (data.length > 10 ? data.slice(0, 10) : "unknown");
  }
}

/** `UnderwritingApplied` / `UnderwritingRefused`: one item of an underwriting report. */
export async function onUnderwritingItem(log: CreLog, at: string): Promise<void> {
  const linked = log.args.linkedWallet ? getAddress(log.args.linkedWallet as string) : null;
  const item = {
    user: getAddress(log.args.user as string),
    linkedWallet: linked && !/^0x0{40}$/i.test(linked) ? linked : null,
    applied: log.eventName === "UnderwritingApplied",
    score: log.eventName === "UnderwritingApplied" ? Number(log.args.score) : null,
    reason: log.eventName === "UnderwritingRefused" ? reasonName(log.args.reason as Hex, underwritingReceiverAbi as unknown as Abi) : null,
  };
  await upsertRun(log.txHash.toLowerCase(), base(log, at, "underwrite"), (r) => {
    const items = r.underwrite?.items ?? [];
    if (items.some((i) => i.user === item.user && i.applied === item.applied)) return r;
    return { ...r, underwrite: { items: [...items, item] } };
  });
  await recordReport(item, { txHash: log.txHash, at, blockNumber: log.blockNumber });
}

/**
 * Keep the report transaction on the account's credit decision: the chain's
 * own record of what the DON wrote. A decision whose signed callback never
 * came (a simulation run without one) is created from the chain event, and
 * the next credit read explains it from that transaction.
 */
async function recordReport(
  item: { user: Address; linkedWallet: Address | null; applied: boolean; score: number | null; reason: string | null },
  report: { txHash: Hex; at: string; blockNumber: number },
): Promise<void> {
  const db = getDb();
  const id = item.user.toLowerCase();
  const updated = await db.creditDecisions.update(id, (d) => {
    if (d.report && d.report.blockNumber > report.blockNumber) return d;
    // A refusal never undoes a line already opened (an account underwritten twice is refused the second time).
    if (!item.applied && d.status === "applied") return d;
    // Another report than the one explained: explain again on the next read.
    const explanation = d.txHash && d.txHash.toLowerCase() === report.txHash.toLowerCase() ? d.explanation : undefined;
    return { ...d, report, txHash: report.txHash, explanation, status: item.applied ? "applied" : d.status };
  });
  if (updated) return;
  try {
    await db.creditDecisions.insert({
      id,
      status: item.applied ? "applied" : "refused",
      score: item.score,
      reason: item.reason,
      linkedWallet: item.linkedWallet,
      txHash: report.txHash,
      callbackId: `chain:${report.txHash}`,
      at: report.at,
      report,
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/** `CreditGuardUpdated` / `AttestationRefused`: one guardian attestation, accepted or refused. */
export async function onGuardianReport(log: CreLog, at: string): Promise<void> {
  let guardian: NonNullable<CreRunRecord["guardian"]>;
  if (log.eventName === "CreditGuardUpdated") {
    const a = log.args.attestation as { priceRoundId: bigint; price: bigint; freeCash: bigint; observedAt: bigint };
    guardian = {
      accepted: true,
      round: Number(log.args.round),
      creditPaused: Boolean(log.args.creditPaused),
      reasons: Number(log.args.reasons),
      price: str(a.price),
      priceRoundId: str(a.priceRoundId),
      freeCashUnits: str(a.freeCash),
      observedAt: new Date(Number(a.observedAt) * 1000).toISOString(),
      refusal: null,
    };
  } else {
    guardian = {
      accepted: false,
      round: null,
      creditPaused: null,
      reasons: null,
      price: null,
      priceRoundId: null,
      freeCashUnits: null,
      observedAt: new Date(Number(log.args.observedAt) * 1000).toISOString(),
      refusal: reasonName(log.args.reason as Hex, guardianReceiverAbi as unknown as Abi),
    };
  }
  await upsertRun(log.txHash.toLowerCase(), base(log, at, "guardian"), (r) => ({ ...r, guardian }));
}
