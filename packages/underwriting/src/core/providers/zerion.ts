/**
 * Zerion's wallet API: the documented shapes, the requests, the parsers.
 *
 * Shapes follow Zerion's OpenAPI (docs/research/data.md §3). All GET, HTTP
 * Basic with the key as the username. Paths need the trailing slash: without
 * it Zerion answers 301 and CRE does not follow redirects. `X-Env: testnet`
 * works on positions and transactions only, which is how the buyer's Monad
 * testnet account is read (`monad-test-v2`).
 *
 * Zerion is the documented fallback for Nansen (a wallet's age when Nansen has
 * no first funder, or is down) and the primary source for exact balances and
 * for savings and trading tenure.
 */

import { STABLE_SYMBOLS } from "../constants.ts";
import { asArray, base64Ascii, isObject, lower, ParseError, parseTimestamp, queryString, type RequestSpec } from "./common.ts";

export const ZERION_BASE_URL = "https://api.zerion.io";

// ---------------------------------------------------------------- shapes

export interface ZerionQuantity {
  int: string;
  decimals: number;
  float: number;
  numeric: string;
}

export interface ZerionFungibleInfo {
  name: string;
  symbol: string;
  icon?: { url: string } | null;
  flags: { verified: boolean };
  implementations: Array<{ chain_id: string; address: string | null; decimals: number }>;
}

export interface ZerionTransaction {
  type: "transactions";
  id: string;
  attributes: {
    operation_type:
      | "approve" | "bid" | "burn" | "claim" | "delegate" | "deploy" | "deposit" | "execute"
      | "mint" | "receive" | "revoke" | "revoke_delegation" | "send" | "trade" | "withdraw";
    hash: string;
    mined_at_block: number;
    mined_at: string;
    sent_from: string;
    sent_to: string;
    status: "confirmed" | "failed" | "pending";
    nonce: number;
    fee?: { fungible_info?: ZerionFungibleInfo; quantity: ZerionQuantity; value: number | null; price: number | null } | null;
    transfers: Array<{
      fungible_info?: ZerionFungibleInfo;
      direction: "in" | "out" | "self";
      quantity: ZerionQuantity;
      value: number | null;
      price: number | null;
      sender: string;
      recipient: string;
    }>;
    approvals: unknown[];
    application_metadata?: { name?: string; contract_address?: string; method?: { id: string; name: string } } | null;
    flags: { is_trash: boolean };
    acts?: unknown[];
  };
  relationships: {
    chain: { data: { type: "chains"; id: string } };
    dapp?: { data: { type: "dapps"; id: string } };
  };
}

export interface ZerionTransactionsResponse {
  links: { self: string; next?: string };
  data: ZerionTransaction[];
}

export interface ZerionPosition {
  type: "positions";
  id: string;
  attributes: {
    parent: string | null;
    protocol: string | null;
    name: string;
    position_type: "wallet" | "deposit" | "loan" | "locked" | "staked" | "reward" | "investment";
    quantity: ZerionQuantity;
    value: number | null;
    price: number;
    changes?: { absolute_1d: number; percent_1d: number } | null;
    fungible_info: ZerionFungibleInfo;
    flags: { displayable: boolean; is_trash: boolean };
    application_metadata?: { name?: string } | null;
    updated_at: string;
    updated_at_block: number | null;
  };
  relationships: {
    chain: { data: { type: "chains"; id: string } };
    fungible: { data: { type: "fungibles"; id: string } };
  };
}

export interface ZerionPositionsResponse {
  links: { self: string };
  data: ZerionPosition[];
}

export interface ZerionErrorBody {
  errors: Array<{ title: string; detail: string }>;
}

// ---------------------------------------------------------------- requests

export interface ZerionTransactionsQuery {
  testnet?: boolean;
  chainIds?: string[];
  pageSize?: number;
  /** Unix seconds; sent as 13-digit milliseconds, as Zerion requires. */
  minMinedAt?: number;
  maxMinedAt?: number;
  operationTypes?: ZerionTransaction["attributes"]["operation_type"][];
  trash?: "only_trash" | "only_non_trash" | "no_filter";
}

function get(endpoint: string, path: string, query: string, testnet: boolean): RequestSpec {
  return {
    provider: "zerion",
    endpoint,
    method: "GET",
    url: `${ZERION_BASE_URL}${path}${query ? `?${query}` : ""}`,
    headers: testnet ? { accept: "application/json", "X-Env": "testnet" } : { accept: "application/json" },
  };
}

const ms = (unix: number | undefined) => (unix === undefined ? undefined : String(Math.floor(unix) * 1000).padStart(13, "0"));

export const zerionRequests = {
  transactions: (address: string, q: ZerionTransactionsQuery = {}) =>
    get(
      "transactions",
      `/v1/wallets/${lower(address)}/transactions/`,
      queryString([
        ["currency", "usd"],
        ["filter[chain_ids]", q.chainIds?.join(",")],
        ["filter[operation_types]", q.operationTypes?.join(",")],
        ["filter[min_mined_at]", ms(q.minMinedAt)],
        ["filter[max_mined_at]", ms(q.maxMinedAt)],
        ["filter[trash]", q.trash],
        ["page[size]", q.pageSize ?? 100],
      ]),
      q.testnet ?? false,
    ),

  positions: (address: string, q: { testnet?: boolean; chainIds?: string[] } = {}) =>
    get(
      "positions",
      `/v1/wallets/${lower(address)}/positions/`,
      queryString([
        ["currency", "usd"],
        ["filter[chain_ids]", q.chainIds?.join(",")],
        ["filter[positions]", "only_simple"],
        ["filter[trash]", "only_non_trash"],
      ]),
      q.testnet ?? false,
    ),
} as const;

/** `Authorization` value for a Zerion key: Basic base64("<key>:"). */
export function zerionAuthorization(apiKey: string): string {
  return `Basic ${base64Ascii(`${apiKey}:`)}`;
}

// ---------------------------------------------------------------- parsers

export interface ZerionTxRow {
  minedAt: number;
  operationType: string;
  status: string;
  chainId: string;
  trash: boolean;
}

export function parseTransactions(body: unknown): { rows: ZerionTxRow[]; hasNext: boolean } {
  if (!isObject(body)) throw new ParseError("zerion transactions: body is not an object");
  const rows: ZerionTxRow[] = [];
  for (const item of asArray(body.data, "zerion transactions.data")) {
    if (!isObject(item) || !isObject(item.attributes)) throw new ParseError("zerion transactions: row has no attributes");
    const a = item.attributes;
    const minedAt = parseTimestamp(a.mined_at);
    if (minedAt === null) throw new ParseError("zerion transactions: unreadable mined_at");
    const rel = isObject(item.relationships) && isObject(item.relationships.chain) && isObject(item.relationships.chain.data)
      ? item.relationships.chain.data
      : null;
    rows.push({
      minedAt,
      operationType: String(a.operation_type ?? ""),
      status: String(a.status ?? ""),
      chainId: rel ? String(rel.id ?? "") : "",
      trash: isObject(a.flags) ? a.flags.is_trash === true : false,
    });
  }
  const links = isObject(body.links) ? body.links : {};
  return { rows, hasNext: typeof links.next === "string" && links.next !== "" };
}

/** Confirmed, non-trash activity in one page. */
export function countedRows(page: { rows: ZerionTxRow[] }): ZerionTxRow[] {
  return page.rows.filter((r) => r.status === "confirmed" && !r.trash);
}

/**
 * Dollars held, in base units, summed exactly from `quantity.int` as BigInt so
 * 18-decimal DAI stays exact. Rows must be simple wallet positions, verified,
 * not trash, a dollar symbol, and priced within 5% of $1.
 */
export function parsePositionsStables(body: unknown): number {
  if (!isObject(body)) throw new ParseError("zerion positions: body is not an object");
  let total = 0n;
  for (const item of asArray(body.data, "zerion positions.data")) {
    if (!isObject(item) || !isObject(item.attributes)) continue;
    const a = item.attributes;
    if (a.position_type !== "wallet") continue;
    if (isObject(a.flags) && a.flags.is_trash === true) continue;
    const info = isObject(a.fungible_info) ? a.fungible_info : null;
    if (!info || !isObject(info.flags) || info.flags.verified !== true) continue;
    const symbol = typeof info.symbol === "string" ? info.symbol.toUpperCase() : "";
    if (!STABLE_SYMBOLS.has(symbol)) continue;
    if (typeof a.price === "number" && !(a.price > 0.95 && a.price < 1.05)) continue;
    const q = isObject(a.quantity) ? a.quantity : null;
    if (!q || typeof q.int !== "string" || !/^\d+$/.test(q.int) || typeof q.decimals !== "number") continue;
    const decimals = BigInt(q.decimals);
    const amount = BigInt(q.int);
    total += decimals >= 6n ? amount / 10n ** (decimals - 6n) : amount * 10n ** (6n - decimals);
  }
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(total > max ? max : total);
}

/**
 * Zerion's "address … is not trackable" 400: exchange hot wallets, routers,
 * token contracts. It means "no data", not "retry" (data.md §3.3).
 */
export function isNotTrackable(status: number, body: unknown): boolean {
  if (status !== 400 || !isObject(body)) return false;
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return errors.some((e) => isObject(e) && /not trackable/i.test(String(e.detail ?? e.title ?? "")));
}
