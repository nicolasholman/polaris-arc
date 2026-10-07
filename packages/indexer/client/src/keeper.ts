/**
 * Collection candidates from the indexer, for the Polaris keeper
 * (services/keeper) or any script that builds a collections report: the
 * request to send, and the task list built from the answer. Pure functions
 * with no dependencies.
 *
 *   const req = dueCandidatesRequest(now, 50);
 *   const tasks = parseDueCandidates(await post(indexerUrl, req), now); // the indexer proposes
 *   const ready = await collectionsReceiver.read.checkTasks([tasks]);   // the chain disposes
 *   const report = readyTasks(tasks, ready);                            // abi.encode(1, report) -> submitReport
 *
 * The indexer only proposes: CollectionsReceiver.checkTasks decides what is
 * actionable now, and the receiver re-checks every task when the keeper
 * submits the report, so a stale index costs a skipped task, never a wrong
 * collection.
 */

import { DUE_CANDIDATES } from "./documents.ts";

/** CollectionsReceiver task actions. */
export const COLLECTION_ACTION = { COLLECT_INSTALLMENT: 1, CHARGE_SUBSCRIPTION: 2, LIQUIDATE: 3 } as const;
export type CollectionAction = (typeof COLLECTION_ACTION)[keyof typeof COLLECTION_ACTION];

export type Task = { readonly action: CollectionAction; readonly id: bigint };

/** The report body CollectionsReceiver.submitReport decodes: abi.encode(uint8 kind = 1, Task[] tasks). */
export const REPORT_ABI_PARAMETERS = "uint8 kind, (uint8 action, uint256 id)[] tasks";
export const REPORT_KIND_COLLECTIONS = 1;
/**
 * The one EVM read per run, and the default cap on the candidates it checks:
 * each task is two ABI words, so 72 keep the call small for any RPC. The
 * keeper then submits at most its own report cap of the ready ones
 * (KEEPER_MAX_TASKS in services/keeper).
 */
export const CHECK_TASKS_SIGNATURE = "function checkTasks((uint8 action, uint256 id)[] tasks) view returns (bool[] ready)";
export const MAX_TASKS_PER_READ = 72;

export function dueCandidatesRequest(now: number, limit = 50): { query: string; variables: { now: number; limit: number } } {
  if (!Number.isInteger(now) || now <= 0) throw new RangeError(`now must be unix seconds, got ${now}`);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) throw new RangeError(`limit must be 1-500, got ${limit}`);
  return { query: DUE_CANDIDATES, variables: { now, limit } };
}

type CandidateRows = {
  Loan?: Array<{ loanId: string | number; liquidatableAt?: number | null }>;
  Subscription?: Array<{ subId: string | number }>;
};

/**
 * The tasks to check on chain, from the indexer's answer (the whole GraphQL
 * response, or just its `data`) to the request made at `now`. A plan past
 * its grace period is liquidated, never collected; liquidations come first,
 * then collections, then charges, each sorted by id and deduplicated, so
 * the same answer always builds the same list (and the same report).
 */
export function parseDueCandidates(response: unknown, now: number, maxTasks = MAX_TASKS_PER_READ): Task[] {
  const body = response as { data?: CandidateRows; errors?: Array<{ message: string }> } & CandidateRows;
  if (body?.errors?.length) throw new Error(`indexer: ${body.errors.map((e) => e.message).join("; ")}`);
  const data: CandidateRows = body?.data ?? body ?? {};
  const byId = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  const unique = (ids: bigint[]) => [...new Set(ids)].sort(byId);
  const loans = data.Loan ?? [];
  const pastGrace = (r: { liquidatableAt?: number | null }) => r.liquidatableAt !== null && r.liquidatableAt !== undefined && r.liquidatableAt <= now;
  const liquidate = unique(loans.filter(pastGrace).map((r) => BigInt(r.loanId)));
  const gone = new Set(liquidate);
  const collect = unique(loans.filter((r) => !pastGrace(r)).map((r) => BigInt(r.loanId))).filter((id) => !gone.has(id));
  const charge = unique((data.Subscription ?? []).map((r) => BigInt(r.subId)));
  const tasks: Task[] = [
    ...liquidate.map((id) => ({ action: COLLECTION_ACTION.LIQUIDATE, id })),
    ...collect.map((id) => ({ action: COLLECTION_ACTION.COLLECT_INSTALLMENT, id })),
    ...charge.map((id) => ({ action: COLLECTION_ACTION.CHARGE_SUBSCRIPTION, id })),
  ];
  return tasks.slice(0, maxTasks);
}

/** Keep the tasks CollectionsReceiver.checkTasks said are actionable. */
export function readyTasks(tasks: readonly Task[], ready: readonly boolean[]): Task[] {
  if (ready.length !== tasks.length) throw new Error(`checkTasks returned ${ready.length} flags for ${tasks.length} tasks`);
  return tasks.filter((_, i) => ready[i]);
}
