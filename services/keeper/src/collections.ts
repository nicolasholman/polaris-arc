/**
 * The collections run: every `intervalSeconds`, and at once for a buyer who
 * re-signs (PolarisCheckout.Reauthorized).
 *
 *   1. Candidates from the chain: the newest loan and subscription ids, and a
 *      rotating slice of older ones (tasks.ts chainWindow).
 *   2. The chain disposes: `CollectionsReceiver.checkTasks` says which are
 *      actionable now; the dunning ladder (backoff.ts) holds back a buyer
 *      who failed recently.
 *   3. One report, `submitReport(abi.encode(uint8 1, tasks))`, from the
 *      keeper's EOA, gas paid in USDC.
 *   4. The receipt is read back: TaskExecuted / TaskSkipped per task, and a
 *      signed `collections.run` callback tells Polaris for Business to sync
 *      now (webhooks, dunning). Every run also sends `collections.heartbeat`,
 *      so the dashboard knows the keeper is alive when nothing was due.
 */

import { collectionsReceiverAbi, polarisCheckoutAbi, polarisLoanEngineAbi, polarisPaymentsAbi } from "@polarispay/contracts/abi";
import { type Address, decodeErrorResult, decodeEventLog, type Hex, type Log } from "viem";

import { instalmentDueAt, loanVerdict, subscriptionVerdict } from "./backoff.ts";
import { postCallback } from "./callback.ts";
import { type Clients, submitReport } from "./chain.ts";
import type { KeeperConfig } from "./config.ts";
import { ACTION, ACTION_NAME, CHECK_BATCH, chainWindow, chunk, encodeCollectionsReport, planTasks, type Ready, type Task } from "./tasks.ts";

export type RunSummary = {
  trigger: "timer" | "reauthorized";
  checked: number;
  tasks: Array<{ action: string; id: string }>;
  heldBack: number;
  txHash: Hex | null;
  executed: number;
  skipped: number;
  skips: Array<{ action: string; id: string; reason: string }>;
  error: string | null;
};

type Loan = { startedAt: bigint; intervalSeconds: bigint; installmentsPaid: number };
type Sub = { nextChargeAt: bigint };

const ERRORS = [...polarisLoanEngineAbi, ...polarisPaymentsAbi, ...collectionsReceiverAbi].filter((x) => x.type === "error");

export function decodeSkip(reason: Hex): string {
  if (!reason || reason === "0x") return "reverted";
  try {
    const d = decodeErrorResult({ abi: ERRORS, data: reason });
    return d.args && d.args.length ? `${d.errorName}(${d.args.map(String).join(", ")})` : d.errorName;
  } catch {
    return `unknown(${reason.slice(0, 10)})`;
  }
}

async function checkTasks(c: Clients, config: KeeperConfig, tasks: Task[]): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const batch of chunk(tasks, CHECK_BATCH)) {
    const ready = (await c.public.readContract({
      address: config.contracts.collections,
      abi: collectionsReceiverAbi,
      functionName: "checkTasks",
      args: [batch.map((t) => ({ action: t.action, id: t.id }))],
    })) as readonly boolean[];
    out.push(...ready);
  }
  return out;
}

/** Candidates from the chain, filtered to what is actionable and on its rung of the ladder. */
export async function findTasks(c: Clients, config: KeeperConfig, tick: bigint, now: number): Promise<{ ready: Ready; checked: number; heldBack: number }> {
  const cc = config.collections;
  const [loanCount, subCount] = await Promise.all([
    c.public.readContract({ address: config.contracts.loanEngine, abi: polarisLoanEngineAbi, functionName: "loanCount" }) as Promise<bigint>,
    c.public.readContract({ address: config.contracts.payments, abi: polarisPaymentsAbi, functionName: "subscriptionCount" }) as Promise<bigint>,
  ]);
  const loanIds = chainWindow(loanCount, cc.recentWindow, cc.sweepWindow, tick);
  const subIds = chainWindow(subCount, cc.recentWindow, cc.sweepWindow, tick);
  const candidates: Task[] = [
    ...loanIds.map((id) => ({ action: ACTION.COLLECT_INSTALLMENT, id }) as Task),
    ...(cc.liquidate ? loanIds.map((id) => ({ action: ACTION.LIQUIDATE, id }) as Task) : []),
    ...subIds.map((id) => ({ action: ACTION.CHARGE_SUBSCRIPTION, id }) as Task),
  ];
  const flags = await checkTasks(c, config, candidates);
  const ready: Ready = { collect: [], charge: [], liquidate: [] };
  candidates.forEach((t, i) => {
    if (!flags[i]) return;
    if (t.action === ACTION.COLLECT_INSTALLMENT) ready.collect.push(t.id);
    else if (t.action === ACTION.LIQUIDATE) ready.liquidate.push(t.id);
    else ready.charge.push(t.id);
  });
  let heldBack = 0;
  const b = cc.backoff;
  if (b) {
    const liquidatable = new Set(ready.liquidate.map(String));
    const keepCollect: bigint[] = [];
    for (const id of ready.collect) {
      const loan = (await c.public.readContract({ address: config.contracts.loanEngine, abi: polarisLoanEngineAbi, functionName: "getLoan", args: [id] })) as Loan;
      const v = loanVerdict(now, instalmentDueAt(loan), liquidatable.has(String(id)), b);
      if (v.attempt) keepCollect.push(id);
      else heldBack++;
    }
    const keepCharge: bigint[] = [];
    for (const id of ready.charge) {
      const sub = (await c.public.readContract({ address: config.contracts.payments, abi: polarisPaymentsAbi, functionName: "getSubscription", args: [id] })) as Sub;
      const v = subscriptionVerdict(now, Number(sub.nextChargeAt), b);
      if (v.attempt) keepCharge.push(id);
      else heldBack++;
    }
    ready.collect = keepCollect;
    ready.charge = keepCharge;
  }
  return { ready, checked: candidates.length, heldBack };
}

/** Write one report and read what it did. */
export async function deliver(c: Clients, config: KeeperConfig, tasks: Task[]) {
  const { hash, receipt } = await submitReport(c, config.chainId, config.contracts.collections, encodeCollectionsReport(tasks));
  let executed = 0;
  let skipped = 0;
  const skips: RunSummary["skips"] = [];
  for (const log of receipt.logs as Log[]) {
    if (log.address.toLowerCase() !== config.contracts.collections.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: collectionsReceiverAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "TaskExecuted") executed++;
      if (ev.eventName === "TaskSkipped") {
        skipped++;
        const a = ev.args as { action: number; id: bigint; reason: Hex };
        skips.push({ action: ACTION_NAME[a.action] ?? String(a.action), id: a.id.toString(), reason: decodeSkip(a.reason) });
      }
    } catch {
      // another event
    }
  }
  return { hash, status: receipt.status, executed, skipped, skips };
}

export async function runCollections(c: Clients, config: KeeperConfig, tick: bigint): Promise<RunSummary> {
  const summary: RunSummary = { trigger: "timer", checked: 0, tasks: [], heldBack: 0, txHash: null, executed: 0, skipped: 0, skips: [], error: null };
  try {
    const now = Number((await c.public.getBlock({ blockTag: "latest" })).timestamp);
    const found = await findTasks(c, config, tick, now);
    summary.checked = found.checked;
    summary.heldBack = found.heldBack;
    const tasks = planTasks(found.ready, config.collections.maxTasksPerReport);
    summary.tasks = tasks.map((t) => ({ action: ACTION_NAME[t.action]!, id: t.id.toString() }));
    if (tasks.length && c.wallet) {
      const d = await deliver(c, config, tasks);
      Object.assign(summary, { txHash: d.hash, executed: d.executed, skipped: d.skipped, skips: d.skips });
      await postCallback(config.callback, { id: `collections:${d.hash}`, type: "collections.run", txHash: d.hash, tasks: tasks.length, executed: d.executed, skipped: d.skipped });
    }
  } catch (e) {
    summary.error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
  }
  await postCallback(config.callback, { id: `heartbeat:${Date.now()}`, type: "collections.heartbeat", tasks: summary.tasks.length, error: summary.error });
  return summary;
}

/** Buyers who re-signed since `fromBlock`, with the latest block read. */
export async function reauthorizedSince(c: Clients, config: KeeperConfig, fromBlock: bigint): Promise<{ buyers: Address[]; toBlock: bigint }> {
  const toBlock = await c.public.getBlockNumber();
  if (toBlock < fromBlock) return { buyers: [], toBlock: fromBlock - 1n };
  const buyers = new Set<Address>();
  const STEP = 5_000n;
  for (let from = fromBlock; from <= toBlock; from += STEP) {
    const to = from + STEP - 1n < toBlock ? from + STEP - 1n : toBlock;
    const logs = await c.public.getContractEvents({ address: config.contracts.checkout, abi: polarisCheckoutAbi, eventName: "Reauthorized", fromBlock: from, toBlock: to });
    for (const l of logs) buyers.add((l.args as { buyer: Address }).buyer);
  }
  return { buyers: [...buyers], toBlock };
}

/** The instant retry: collect what fell due for `buyer`, now that they signed again. */
export async function retryBuyer(c: Clients, config: KeeperConfig, buyer: Address): Promise<RunSummary> {
  const summary: RunSummary = { trigger: "reauthorized", checked: 0, tasks: [], heldBack: 0, txHash: null, executed: 0, skipped: 0, skips: [], error: null };
  try {
    const due = (await c.public.readContract({ address: config.contracts.collections, abi: collectionsReceiverAbi, functionName: "dueTasksFor", args: [buyer] })) as readonly { action: number; id: bigint }[];
    const tasks = due.slice(0, config.collections.maxTasksPerReport).map((t) => ({ action: t.action as Task["action"], id: t.id }));
    summary.checked = due.length;
    summary.tasks = tasks.map((t) => ({ action: ACTION_NAME[t.action]!, id: t.id.toString() }));
    if (tasks.length && c.wallet) {
      const d = await deliver(c, config, tasks);
      Object.assign(summary, { txHash: d.hash, executed: d.executed, skipped: d.skipped, skips: d.skips });
      await postCallback(config.callback, { id: `collections:${d.hash}`, type: "collections.run", txHash: d.hash, buyer, tasks: tasks.length, executed: d.executed, skipped: d.skipped });
    }
  } catch (e) {
    summary.error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
  }
  return summary;
}
