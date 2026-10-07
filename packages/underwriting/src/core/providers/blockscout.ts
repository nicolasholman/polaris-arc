/**
 * Blockscout's Etherscan-style API on Arc's explorer: where a Polaris
 * account's history is read. Keyless.
 *
 *   GET {explorerApiUrl}?module=account&action=txlist&address=<a>&sort=asc&page=1&offset=1
 *   GET {explorerApiUrl}?module=account&action=tokentx&address=<a>&sort=asc|desc&page=1&offset=N
 *
 * Shapes, checked against https://explorer.testnet.arc.io/api:
 *
 *   { "message": "OK", "status": "1", "result": [ { "timeStamp": "1761760791", "from": "0x…", "to": "0x…", ... } ] }
 *   { "message": "No transactions found", "status": "0", "result": [] }          a known empty
 *   { "message": "Invalid address format", "status": "0", "result": null }       an error
 *
 * `txlist` holds the transactions an address sent or received; `tokentx` its
 * token transfers. A Polaris account rarely sends a transaction itself (the
 * relayer submits what it signs and pays the gas, in USDC), so its history
 * is mostly token transfers: both lists are read. On Arc a plain USDC
 * transfer also emits the ERC-20 Transfer event, so `tokentx` sees it too.
 */

import { asArray, isObject, lower, ParseError, parseTimestamp, queryString, type RequestSpec } from "./common.ts";

function get(apiUrl: string, endpoint: string, params: ReadonlyArray<readonly [string, string | number | undefined]>): RequestSpec {
  const base = apiUrl.replace(/\/+$/, "");
  return {
    provider: "blockscout",
    endpoint,
    method: "GET",
    url: `${base}?${queryString(params)}`,
    headers: { accept: "application/json" },
  };
}

const list = (action: "txlist" | "tokentx") => (apiUrl: string, address: string, sort: "asc" | "desc", offset: number) =>
  get(apiUrl, action, [
    ["module", "account"],
    ["action", action],
    ["address", lower(address)],
    ["sort", sort],
    ["page", 1],
    ["offset", offset],
  ]);

export const blockscoutRequests = {
  /** The address's transactions, oldest first with `sort: "asc"`. */
  txlist: list("txlist"),
  /** The address's token transfers. */
  tokentx: list("tokentx"),
} as const;

/** The rows, with "No transactions found" (status "0", empty result) read as a known empty. */
function rows(body: unknown, what: string): unknown[] {
  if (!isObject(body)) throw new ParseError(`${what}: body is not an object`);
  if (Array.isArray(body.result)) return body.result;
  const msg = `${String(body.message ?? "")} ${typeof body.result === "string" ? body.result : ""}`.trim();
  if (/no (transactions|token transfers|records) found/i.test(msg)) return [];
  throw new ParseError(`${what}: ${msg.slice(0, 120) || "unexpected response"}`);
}

function timeOf(row: unknown, what: string): number {
  if (!isObject(row)) throw new ParseError(`${what}: row is not an object`);
  const t = parseTimestamp(row.timeStamp);
  if (t === null) throw new ParseError(`${what}: row has no readable timeStamp`);
  return t;
}

/** The oldest transaction's time in the page, or null when there is none. */
export function parseFirstTransaction(body: unknown): number | null {
  const all = asArray(rows(body, "blockscout txlist"), "blockscout txlist");
  let first: number | null = null;
  for (const row of all) {
    const t = timeOf(row, "blockscout txlist");
    if (first === null || t < first) first = t;
  }
  return first;
}

/**
 * Token transfers in the page: the oldest one's time, how many there are, and
 * how many `address` sent. `full` is true when the page is as long as asked,
 * so the counts are floors.
 */
export function parseTransfers(body: unknown, address: string, pageSize: number): { firstAt: number | null; count: number; sent: number; full: boolean } {
  const all = asArray(rows(body, "blockscout tokentx"), "blockscout tokentx");
  const me = lower(address);
  let firstAt: number | null = null;
  let sent = 0;
  for (const row of all) {
    const t = timeOf(row, "blockscout tokentx");
    if (firstAt === null || t < firstAt) firstAt = t;
    if (isObject(row) && typeof row.from === "string" && lower(row.from) === me) sent++;
  }
  return { firstAt, count: all.length, sent, full: all.length >= pageSize };
}
