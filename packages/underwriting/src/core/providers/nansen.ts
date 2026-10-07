/**
 * Nansen's profiler API: the documented shapes, the requests, the parsers.
 *
 * Shapes follow Nansen's OpenAPI 1.0.0 as recorded in docs/research/data.md
 * §2.5. Every endpoint is a POST with a JSON body and the key in an `apikey`
 * header. Nansen covers Monad mainnet only, so it scores a linked history
 * wallet, never the buyer's new testnet account (data.md §0).
 *
 * The request bodies are held to Nansen's published request schemas
 * (`NANSEN_REQUEST_SCHEMA`), which disagree with each other on purpose: see
 * there. Every response shape here is still UNVERIFIED against a live call
 * (data.md §9); `pnpm --filter @polarispay/underwriting record` checks both.
 *
 * Credits (Free and Pro): first-funder, related-wallets, transactions (per
 * page), pnl-summary and current-balance 1 each; counterparties 5; labels 100.
 * The recipe spends 2 per linked wallet: first-funder, then related-wallets on
 * the funder.
 */

import { STABLE_SYMBOLS } from "../constants.ts";
import type { Address, Funder } from "../types.ts";
import {
  asArray,
  floatToMicros,
  isAddress,
  isObject,
  isoMinute,
  lower,
  ParseError,
  parseTimestamp,
  type RequestSpec,
} from "./common.ts";

export const NANSEN_BASE_URL = "https://api.nansen.ai";

// ---------------------------------------------------------------- shapes

export interface NansenPagination {
  page: number;
  per_page: number;
  is_last_page: boolean;
}

/** `ProfilerAddressFirstFunderResponse` */
export interface NansenFirstFunderResponse {
  pagination: NansenPagination;
  data: Array<{
    wallet_address: string;
    first_funder_address: string;
    first_funder_name?: string | null;
    transaction_hash: string;
    block_timestamp: string;
    chain: string;
  }>;
}

/** `ProfilerRelatedWallet` rows. */
export interface NansenRelatedWalletsResponse {
  pagination: NansenPagination;
  data: Array<{
    address: string;
    address_label?: string | null;
    relation: string;
    transaction_hash: string;
    block_timestamp: string;
    order: number;
    chain: string;
  }>;
}

/** `ProfilerCounterparty` rows. No timestamps: counterparties cannot give a tenure. */
export interface NansenCounterpartiesResponse {
  pagination: NansenPagination;
  data: Array<{
    counterparty_address: string;
    counterparty_address_label: string[];
    interaction_count: number;
    total_volume_usd: number;
    volume_in_usd: number;
    volume_out_usd: number;
    tokens_info: Array<{
      token_address: string;
      token_symbol: string;
      token_name: string;
      num_transfer: number;
      total_token_amount: number;
      token_in_amount: number;
      token_out_amount: number;
    }>;
  }>;
}

export interface NansenTokenMove {
  token_symbol: string;
  token_amount: number;
  price_usd: number;
  value_usd: number;
  token_address: string;
  chain: string;
  from_address: string;
  to_address: string;
  from_address_label?: string | null;
  to_address_label?: string | null;
}

/** `ProfilerTransaction` rows. */
export interface NansenTransactionsResponse {
  pagination: NansenPagination;
  data: Array<{
    chain: string;
    method: string;
    volume_usd: number;
    block_timestamp: string;
    transaction_hash: string;
    source_type: string;
    tokens_sent: NansenTokenMove[];
    tokens_received: NansenTokenMove[];
  }>;
}

export interface NansenPnlSummaryResponse {
  pagination: NansenPagination;
  top5_tokens: Array<{
    realized_pnl: number;
    realized_roi: number;
    token_address: string;
    token_symbol: string;
    chain: string;
  }>;
  traded_token_count: number;
  traded_times: number;
  realized_pnl_usd: number;
  realized_pnl_percent: number;
  win_rate: number;
}

export interface NansenCurrentBalanceResponse {
  pagination: NansenPagination;
  data: Array<{
    chain: string;
    address: string;
    token_address: string;
    token_symbol: string;
    token_name: string;
    token_amount: number;
    price_usd: number;
    value_usd: number;
  }>;
}

export type NansenLabelCategory = "smart_money" | "behavioral" | "defi" | "social" | "cefi" | "nft" | "others";

export interface NansenLabelsResponse {
  pagination: NansenPagination;
  data: Array<{ label: string; category: NansenLabelCategory; kind?: string[] }>;
}

/** Every status but 402. */
export interface NansenErrorBody {
  error: string;
  message: string;
  code:
    | "invalid_field_value"
    | "unknown_field"
    | "invalid_date_range"
    | "insufficient_credits"
    | "rate_limit_exceeded"
    | "query_timeout"
    | "unauthenticated"
    | string;
  status: number;
  request_id: string;
  doc_url: string;
  param?: string;
  retry_after?: number;
}

// ---------------------------------------------------------------- requests

export type NansenEndpoint =
  | "first-funder"
  | "related-wallets"
  | "counterparties"
  | "transactions"
  | "pnl-summary"
  | "current-balance"
  | "labels";

export interface NansenRequestSchema {
  /** The field the wallet goes in. */
  subject: "address" | "wallet_address";
  /** Every property the schema allows. All seven set `additionalProperties: false`. */
  properties: readonly string[];
  required: readonly string[];
  /** Allowed but deprecated, so never sent: Nansen may drop them. */
  deprecated: readonly string[];
}

/**
 * Nansen's request schemas, as docs.nansen.ai publishes them (each endpoint's
 * OpenAPI `…Request` object, re-read on 2026-09-27; data.md §2.5).
 *
 * The wallet field really does differ by endpoint. first-funder,
 * current-balance, transactions, counterparties and labels know only
 * `address`; related-wallets and pnl-summary take `wallet_address` and keep
 * `address` as a deprecated alias. Every schema is closed
 * (`additionalProperties: false`), so "one shape for all" would be refused by
 * one side or lean on the alias. The builders below are checked against this
 * table when they build (a body it refuses throws before any credit is
 * spent), the tests' fixture transport answers a refused body the way Nansen does
 * (422 `unknown_field`), and the recorder prints what the live API said.
 */
export const NANSEN_REQUEST_SCHEMA: Readonly<Record<NansenEndpoint, NansenRequestSchema>> = {
  "first-funder": { subject: "address", properties: ["address", "chain"], required: ["address"], deprecated: [] },
  "related-wallets": {
    subject: "wallet_address",
    properties: ["wallet_address", "address", "chain", "pagination", "order_by"],
    required: ["chain"],
    deprecated: ["address"],
  },
  counterparties: {
    subject: "address",
    properties: ["address", "entity_name", "chain", "date", "source_input", "group_by", "filters", "pagination", "order_by"],
    required: ["chain", "date"],
    deprecated: [],
  },
  transactions: {
    subject: "address",
    properties: ["address", "chain", "date", "hide_spam_token", "filters", "pagination", "order_by"],
    required: ["address", "chain", "date"],
    deprecated: [],
  },
  "pnl-summary": {
    subject: "wallet_address",
    properties: ["wallet_address", "address", "entity_name", "chain", "date"],
    required: ["chain", "date"],
    deprecated: ["address"],
  },
  "current-balance": {
    subject: "address",
    properties: ["address", "entity_name", "chain", "hide_spam_token", "filters", "pagination", "order_by"],
    required: ["chain"],
    deprecated: [],
  },
  labels: { subject: "address", properties: ["address", "chain", "pagination"], required: ["address", "chain"], deprecated: [] },
};

/**
 * Why Nansen would refuse this body, in its own error vocabulary, or null
 * when the schema accepts it. `deprecated_field` is ours: Nansen accepts the
 * alias today, but we do not send it.
 */
export function nansenBodyProblem(
  endpoint: string,
  body: unknown,
): { code: "unknown_endpoint" | "unknown_field" | "missing_field" | "deprecated_field"; param: string | null } | null {
  const schema = (NANSEN_REQUEST_SCHEMA as Record<string, NansenRequestSchema | undefined>)[endpoint];
  if (!schema) return { code: "unknown_endpoint", param: null };
  if (!isObject(body)) return { code: "missing_field", param: schema.required[0] ?? schema.subject };
  for (const key of Object.keys(body)) if (!schema.properties.includes(key)) return { code: "unknown_field", param: key };
  for (const key of schema.required) if (body[key] === undefined) return { code: "missing_field", param: key };
  for (const key of schema.deprecated) if (body[key] !== undefined) return { code: "deprecated_field", param: key };
  if (body[schema.subject] === undefined && body.entity_name === undefined) return { code: "missing_field", param: schema.subject };
  return null;
}

function post(endpoint: NansenEndpoint, body: Record<string, unknown>): RequestSpec {
  const problem = nansenBodyProblem(endpoint, body);
  if (problem) throw new TypeError(`nansen ${endpoint}: the request schema refuses this body (${problem.code}: ${problem.param})`);
  return {
    provider: "nansen",
    endpoint,
    method: "POST",
    url: `${NANSEN_BASE_URL}/api/v1/profiler/address/${endpoint}`,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  };
}

const range = (fromUnix: number, toUnix: number) => ({ from: isoMinute(fromUnix), to: isoMinute(toUnix) });
const subjectOf = (endpoint: NansenEndpoint) => NANSEN_REQUEST_SCHEMA[endpoint].subject;

export const nansenRequests = {
  /** 1 credit. `chain` is fixed to "all"; the schema forbids other fields. */
  firstFunder: (address: string) => post("first-funder", { [subjectOf("first-funder")]: lower(address), chain: "all" }),

  /** 1 credit. One chain per call, no "all". */
  relatedWallets: (address: string, chain: string, perPage = 100) =>
    post("related-wallets", { [subjectOf("related-wallets")]: lower(address), chain, pagination: { page: 1, per_page: perPage } }),

  /** 5 credits. A date range is required. */
  counterparties: (
    address: string,
    chain: string,
    fromUnix: number,
    toUnix: number,
    opts: { sourceInput?: "Combined" | "Tokens" | "ETH"; includeLabels?: string[]; perPage?: number } = {},
  ) =>
    post("counterparties", {
      [subjectOf("counterparties")]: lower(address),
      chain,
      date: range(fromUnix, toUnix),
      source_input: opts.sourceInput ?? "Combined",
      group_by: "wallet",
      ...(opts.includeLabels ? { filters: { include_smart_money_labels: opts.includeLabels } } : {}),
      pagination: { page: 1, per_page: opts.perPage ?? 10 },
      order_by: [{ field: "volume_in_usd", direction: "DESC" }],
    }),

  /** 1 credit per page. `per_page` max 100. ASC with per_page 1 is the oldest row in the range. */
  transactions: (
    address: string,
    chain: string,
    fromUnix: number,
    toUnix: number,
    opts: { sourceType?: string; perPage?: number; direction?: "ASC" | "DESC" } = {},
  ) =>
    post("transactions", {
      [subjectOf("transactions")]: lower(address),
      chain,
      date: range(fromUnix, toUnix),
      hide_spam_token: true,
      ...(opts.sourceType ? { filters: { source_type: opts.sourceType } } : {}),
      pagination: { page: 1, per_page: Math.min(opts.perPage ?? 1, 100) },
      order_by: [{ field: "block_timestamp", direction: opts.direction ?? "ASC" }],
    }),

  /** 1 credit. Not a Facts field; for context only. */
  pnlSummary: (address: string, chain: string, fromUnix: number, toUnix: number) =>
    post("pnl-summary", { [subjectOf("pnl-summary")]: lower(address), chain, date: range(fromUnix, toUnix) }),

  /** 1 credit. Amounts are floats; Zerion's are exact, so this is the balance fallback. */
  currentBalance: (address: string, chain = "all") =>
    post("current-balance", { [subjectOf("current-balance")]: lower(address), chain, hide_spam_token: true, pagination: { page: 1, per_page: 100 } }),

  /** 100 credits, API key only. Off unless configured. */
  labels: (address: string, chain = "all") =>
    post("labels", { [subjectOf("labels")]: lower(address), chain, pagination: { page: 1, per_page: 100 } }),
} as const;

// ---------------------------------------------------------------- parsers

function data(body: unknown, what: string): unknown[] {
  if (!isObject(body)) throw new ParseError(`${what}: body is not an object`);
  return asArray(body.data, `${what}.data`);
}

function pagination(body: unknown): { isLastPage: boolean } {
  const p = isObject(body) && isObject(body.pagination) ? body.pagination : null;
  // Absent pagination means one page: nothing more to fetch.
  return { isLastPage: p ? p.is_last_page !== false : true };
}

/** The first funder, or null when Nansen has no attribution (a known empty). */
export function parseFirstFunder(body: unknown): Funder | null {
  const rows = data(body, "first-funder");
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!isObject(row) || !isAddress(row.first_funder_address) || typeof row.chain !== "string") {
    throw new ParseError("first-funder: row does not match ProfilerAddressFirstFunderResponse");
  }
  const name = typeof row.first_funder_name === "string" && row.first_funder_name.trim() !== "" ? row.first_funder_name : null;
  return {
    address: lower(row.first_funder_address) as Address,
    name,
    chain: row.chain,
    fundedAt: parseTimestamp(row.block_timestamp),
  };
}

/**
 * Distinct related addresses, excluding the subjects themselves. When the
 * page is not the last, the count is reported as 100: at 60 or more the
 * funder is infrastructure, so the exact number does not matter (data.md §6.6).
 */
export function parseRelatedWallets(
  body: unknown,
  exclude: readonly string[] = [],
): { count: number; complete: boolean; labels: string[]; relations: string[] } {
  const rows = data(body, "related-wallets");
  const skip = new Set(exclude.map(lower));
  const seen = new Set<string>();
  const labels: string[] = [];
  const relations = new Set<string>();
  for (const row of rows) {
    if (!isObject(row) || !isAddress(row.address)) throw new ParseError("related-wallets: row has no address");
    const a = lower(row.address);
    if (typeof row.relation === "string") relations.add(row.relation);
    if (typeof row.address_label === "string" && row.address_label) labels.push(row.address_label);
    if (!skip.has(a)) seen.add(a);
  }
  const complete = pagination(body).isLastPage;
  return { count: complete ? seen.size : Math.max(seen.size, 100), complete, labels, relations: [...relations].sort() };
}

/**
 * Dollars held, in base units. Rows must carry a dollar symbol and a price
 * within 5% of $1, so a spam token named "USDC" at $0.0001 cannot pass.
 */
export function parseCurrentBalanceStables(body: unknown): number {
  let total = 0;
  for (const row of data(body, "current-balance")) {
    if (!isObject(row)) continue;
    const symbol = typeof row.token_symbol === "string" ? row.token_symbol.toUpperCase() : "";
    const price = typeof row.price_usd === "number" ? row.price_usd : NaN;
    if (!STABLE_SYMBOLS.has(symbol) || !(price > 0.95 && price < 1.05)) continue;
    total += floatToMicros(typeof row.token_amount === "number" ? row.token_amount : 0);
    if (total > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

/** The oldest row's time, or null when the range is empty. */
export function parseOldestTransaction(body: unknown): number | null {
  let oldest: number | null = null;
  for (const row of data(body, "transactions")) {
    if (!isObject(row)) continue;
    const t = parseTimestamp(row.block_timestamp);
    if (t !== null && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest;
}

export function parseLabels(body: unknown): Array<{ label: string; category: string }> {
  return data(body, "labels")
    .filter(isObject)
    .map((row) => ({ label: String(row.label ?? ""), category: String(row.category ?? "others") }))
    .filter((r) => r.label !== "");
}

export function parseCounterparties(body: unknown): Array<{ address: string; labels: string[]; volumeInUsd: number; volumeOutUsd: number }> {
  return data(body, "counterparties")
    .filter(isObject)
    .filter((row) => isAddress(row.counterparty_address))
    .map((row) => ({
      address: lower(row.counterparty_address as string),
      labels: Array.isArray(row.counterparty_address_label) ? row.counterparty_address_label.map(String) : [],
      volumeInUsd: Number(row.volume_in_usd ?? 0) || 0,
      volumeOutUsd: Number(row.volume_out_usd ?? 0) || 0,
    }));
}

export function parsePnlSummary(body: unknown): {
  realizedPnlUsd: number;
  winRate: number;
  tradedTimes: number;
  tradedTokenCount: number;
} {
  if (!isObject(body)) throw new ParseError("pnl-summary: body is not an object");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    realizedPnlUsd: n(body.realized_pnl_usd),
    winRate: n(body.win_rate),
    tradedTimes: n(body.traded_times),
    tradedTokenCount: n(body.traded_token_count),
  };
}

/** Nansen's error envelope, or null when the body is not one. */
export function parseNansenError(
  body: unknown,
): { code: string; message: string; param: string | null; retryAfterSeconds: number | null } | null {
  if (!isObject(body) || (typeof body.code !== "string" && typeof body.message !== "string")) return null;
  return {
    code: typeof body.code === "string" ? body.code : "unknown",
    message: typeof body.message === "string" ? body.message : "",
    param: typeof body.param === "string" && body.param !== "" ? body.param : null,
    retryAfterSeconds: typeof body.retry_after === "number" && body.retry_after >= 0 ? body.retry_after : null,
  };
}

/** Nansen codes that mean the request we built is not one it takes. */
const REQUEST_CODES: ReadonlySet<string> = new Set(["unknown_field", "invalid_field_value", "missing_field", "invalid_date_range"]);

/**
 * One classification of a non-200 Nansen answer, for the Node client and the
 * CRE recipe alike. `request_rejected` means our body is wrong (a field name,
 * a value, a range), not that Nansen is down: the detail names Nansen's code
 * and `param`, which is what to fix, and it is never worth retrying.
 */
export function classifyNansenFailure(
  status: number,
  body: unknown,
): { code: "insufficient_credits" | "unauthorized" | "not_found" | "request_rejected" | "http_error"; detail: string } {
  const e = parseNansenError(body);
  let code: "insufficient_credits" | "unauthorized" | "not_found" | "request_rejected" | "http_error";
  if (e?.code === "insufficient_credits" || status === 403) code = "insufficient_credits";
  // 402 is the x402 payment challenge a keyless request gets.
  else if (status === 401 || status === 402 || e?.code === "unauthenticated") code = "unauthorized";
  else if (status === 404) code = "not_found";
  else if (status === 400 || status === 422 || (e !== null && REQUEST_CODES.has(e.code))) code = "request_rejected";
  else code = "http_error";
  const detail = e
    ? `HTTP ${status} ${e.code}${e.param ? ` (param ${e.param})` : ""}${e.message ? `: ${e.message}` : ""}`
    : status === 402
      ? `HTTP ${status} payment required (no API key)`
      : `HTTP ${status}`;
  return { code, detail };
}
