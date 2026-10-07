/**
 * Etherscan V2: the one source for past loans closed by a lender.
 *
 * Neither Nansen nor Zerion exposes liquidations (data.md §0 item 8), and
 * Monad's RPC caps `eth_getLogs` at 100 blocks, so prior liquidations come
 * from Etherscan V2's logs API, free on Ethereum, Arbitrum, Polygon and both
 * Monad networks. Anyone can emit a fake `LiquidationCall` naming a victim, so
 * only logs whose emitter is an allowlisted Aave V3 pool count.
 *
 * The key goes in the `apikey` query parameter; the builders leave it out and
 * the caller appends it, so a URL built here is safe to log or cache on.
 */

import { LIQUIDATION_CALL_TOPIC } from "../constants.ts";
import { asArray, isObject, lower, ParseError, parseTimestamp, queryString, type RequestSpec } from "./common.ts";

export const ETHERSCAN_BASE_URL = "https://api.etherscan.io/v2/api";

export interface EtherscanResponse<T> {
  status: "0" | "1";
  message: string;
  result: T;
}

export interface EtherscanLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  timeStamp: string;
  gasPrice: string;
  gasUsed: string;
  logIndex: string;
  transactionHash: string;
  transactionIndex: string;
}

export interface EtherscanTokenTransfer {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  nonce: string;
  blockHash: string;
  from: string;
  contractAddress: string;
  to: string;
  value: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
  transactionIndex: string;
  gas: string;
  gasPrice: string;
  gasUsed: string;
  cumulativeGasUsed: string;
  input: string;
  confirmations: string;
}

/** `toBlock=latest` is UNVERIFIED (data.md §4.3), so a block number past any head. */
const FAR_FUTURE_BLOCK = 99_999_999_999;

function get(endpoint: string, params: ReadonlyArray<readonly [string, string | number | undefined]>): RequestSpec {
  return {
    provider: "etherscan",
    endpoint,
    method: "GET",
    url: `${ETHERSCAN_BASE_URL}?${queryString(params)}`,
    headers: { accept: "application/json" },
  };
}

export const etherscanRequests = {
  /** Every LiquidationCall where `user` (topic3) is the borrower, from any emitter, on one chain. */
  liquidationLogs: (chainId: number, borrower: string) =>
    get("logs", [
      ["chainid", chainId],
      ["module", "logs"],
      ["action", "getLogs"],
      ["fromBlock", 0],
      ["toBlock", FAR_FUTURE_BLOCK],
      ["topic0", LIQUIDATION_CALL_TOPIC],
      ["topic0_3_opr", "and"],
      ["topic3", `0x${lower(borrower).slice(2).padStart(64, "0")}`],
      ["page", 1],
      ["offset", 1000],
    ]),

  /** ERC-20 transfers to or from an address: the history of a gasless account. */
  tokenTransfers: (chainId: number, address: string, sort: "asc" | "desc", offset: number) =>
    get("tokentx", [
      ["chainid", chainId],
      ["module", "account"],
      ["action", "tokentx"],
      ["address", lower(address)],
      ["page", 1],
      ["offset", offset],
      ["sort", sort],
    ]),
} as const;

/** Etherscan answers "No records found" with status "0" and an empty result: a known empty. */
function result(body: unknown, what: string): unknown[] {
  if (!isObject(body)) throw new ParseError(`${what}: body is not an object`);
  if (Array.isArray(body.result)) return body.result;
  const msg = `${String(body.message ?? "")} ${typeof body.result === "string" ? body.result : ""}`;
  if (/no records found|no transactions found/i.test(msg)) return [];
  throw new ParseError(`${what}: ${msg.trim().slice(0, 120) || "unexpected response"}`);
}

/** Liquidations of the borrower by an allowlisted pool. */
export function parseLiquidationCount(body: unknown, pools: readonly string[]): number {
  const allow = new Set(pools.map(lower));
  let n = 0;
  for (const log of result(body, "etherscan logs")) {
    if (!isObject(log) || typeof log.address !== "string") throw new ParseError("etherscan logs: row has no address");
    if (allow.has(lower(log.address))) n++;
  }
  return n;
}

/** The first transfer's time and the number of transfers in the page. */
export function parseTokenTransfers(body: unknown): { firstAt: number | null; count: number } {
  const rows = asArray(result(body, "etherscan tokentx"), "etherscan tokentx");
  let firstAt: number | null = null;
  for (const row of rows) {
    if (!isObject(row)) continue;
    const t = parseTimestamp(row.timeStamp);
    if (t !== null && (firstAt === null || t < firstAt)) firstAt = t;
  }
  return { firstAt, count: rows.length };
}
