/**
 * The collections report CollectionsReceiver.submitReport takes, and how the
 * keeper picks the ids to check each run. Byte for byte the format of
 * packages/contracts/lib/keeper.js (test/tasks.test.ts holds them together).
 */

import { decodeAbiParameters, encodeAbiParameters, type Hex, hexToBigInt, keccak256, numberToHex, parseAbiParameters } from "viem";

export const REPORT_KIND_COLLECTIONS = 1;

export const ACTION = { COLLECT_INSTALLMENT: 1, CHARGE_SUBSCRIPTION: 2, LIQUIDATE: 3 } as const;
export type Action = (typeof ACTION)[keyof typeof ACTION];
export const ACTION_NAME: Record<number, string> = { 1: "collect", 2: "charge", 3: "liquidate" };

export interface Task {
  action: Action;
  id: bigint;
}

export const COLLECTIONS_REPORT_PARAMS = parseAbiParameters("uint8 kind, (uint8 action, uint256 id)[] tasks");

export function encodeCollectionsReport(tasks: readonly Task[]): Hex {
  return encodeAbiParameters(COLLECTIONS_REPORT_PARAMS, [REPORT_KIND_COLLECTIONS, tasks.map((t) => ({ action: t.action, id: t.id }))]);
}

export function decodeCollectionsReport(hex: Hex): { kind: number; tasks: Task[] } {
  const [kind, tasks] = decodeAbiParameters(COLLECTIONS_REPORT_PARAMS, hex);
  return { kind, tasks: tasks.map((t) => ({ action: t.action as Action, id: t.id })) };
}

/** Tasks per `checkTasks` read. */
export const CHECK_BATCH = 150;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The ids to check this run: the newest `recent`, and a rotating slice of
 * `sweep` older ones (rotated by `tick`), so every id is revisited without
 * reading the whole history every minute.
 */
export function chainWindow(count: bigint, recent: number, sweep: number, tick: bigint): bigint[] {
  if (count <= 0n) return [];
  const ids = new Set<bigint>();
  const newestFrom = count - BigInt(recent) + 1n > 1n ? count - BigInt(recent) + 1n : 1n;
  for (let id = newestFrom; id <= count; id++) ids.add(id);
  const older = newestFrom - 1n;
  if (older > 0n && sweep > 0) {
    const span = BigInt(sweep) < older ? BigInt(sweep) : older;
    const start = hexToBigInt(keccak256(numberToHex(tick))) % older;
    for (let k = 0n; k < span; k++) ids.add(((start + k) % older) + 1n);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface Ready {
  collect: bigint[];
  charge: bigint[];
  liquidate: bigint[];
}

/**
 * One report's tasks, at most `max`: each loan's collect before its
 * liquidation (collecting is the buyer's better outcome), loans in id order,
 * then subscription charges.
 */
export function planTasks(ready: Ready, max: number): Task[] {
  const asc = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  const liquidatable = new Set(ready.liquidate.map(String));
  const loans = [...new Set([...ready.collect, ...ready.liquidate].map(String))].map(BigInt).sort(asc);
  const due = new Set(ready.collect.map(String));
  const out: Task[] = [];
  for (const id of loans) {
    const group: Task[] = [];
    if (due.has(String(id))) group.push({ action: ACTION.COLLECT_INSTALLMENT, id });
    if (liquidatable.has(String(id))) group.push({ action: ACTION.LIQUIDATE, id });
    if (out.length + group.length > max) break;
    out.push(...group);
  }
  for (const id of [...new Set(ready.charge.map(String))].map(BigInt).sort(asc)) {
    if (out.length >= max) break;
    out.push({ action: ACTION.CHARGE_SUBSCRIPTION, id });
  }
  return out;
}
