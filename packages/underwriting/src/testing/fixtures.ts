/**
 * A transport that answers from files in `fixtures/` instead of the network:
 * a test double, for tests only.
 *
 * Nothing in the product imports this. It lives under
 * `@polarispay/underwriting/testing`, which no product path imports (and
 * `test/no-fixtures-in-product.test.ts` checks): a provider without its key
 * is "not configured" and never answered from here. Each file holds one
 * response body in the provider's documented shape, wrapped with a `fixture`
 * block that says so:
 *
 *   { "fixture": { "label": "FIXTURE ...", "provider": ..., "shape": ..., "recorded": false },
 *     "status": 200, "headers": { ... }, "body": { ...exactly the documented shape... } }
 *
 * Where the real API filters (Zerion's `max_mined_at` probes, Nansen's date
 * ranges, page sizes), this transport applies the same filter to the file's
 * rows, so a fixture answers a probe for any "now" the way the API would.
 * A request with no file is a failure (`not_found`, "no fixture recorded"), never an empty
 * answer: a fixture must not invent that a wallet has no history.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTimestamp } from "../core/providers/common.ts";
import { nansenBodyProblem } from "../core/providers/nansen.ts";
import { ProviderError, type HttpRequest, type HttpResponse, type HttpTransport } from "../node/http.ts";

/** `packages/underwriting/fixtures`, wherever the package is installed. */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));

export interface FixtureFile {
  fixture: {
    label: string;
    provider: string;
    request: string;
    shape: string;
    persona?: string;
    recorded: boolean;
    recordedAt?: string;
    notes?: string;
  };
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** RPC files hold several calls: `<host>:<method>[:<token>]` → hex result. */
  calls?: Record<string, string>;
}

function missing(provider: string, endpoint: string, file: string): ProviderError {
  return new ProviderError({
    provider,
    endpoint,
    status: 404,
    // A test double's miss: a test that reaches for an unrecorded answer fails loudly.
    code: "not_found",
    message: `no fixture recorded (${file})`,
    retryable: false,
  });
}

function load(dir: string, rel: string, provider: string, endpoint: string): FixtureFile {
  const path = join(dir, rel);
  if (!existsSync(path)) throw missing(provider, endpoint, rel);
  return JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
}

function respond(f: FixtureFile, body: unknown = f.body): HttpResponse {
  return {
    status: f.status ?? 200,
    headers: { "content-type": "application/json", "x-polaris-fixture": "true", ...(f.headers ?? {}) },
    body: JSON.stringify(body),
  };
}

const lower = (s: unknown) => String(s ?? "").toLowerCase();
/** Milliseconds, or NaN, so an unreadable row never passes a range filter. */
const ts = (s: unknown) => {
  const t = parseTimestamp(s);
  return t === null ? NaN : t * 1000;
};

/**
 * Which fixture file answers a request, and under which key for RPC files.
 * The one mapping both the fixture transport and `scripts/record.ts` use.
 */
export function locateFixture(req: HttpRequest): { provider: string; endpoint: string; rel: string; rpcKey?: string } {
  const url = new URL(req.url);
  if (url.hostname === "api.nansen.ai") {
    const endpoint = url.pathname.split("/").pop() ?? "";
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    const address = lower(body.address ?? body.wallet_address);
    const rel = endpoint === "related-wallets" ? `nansen/${endpoint}/${address}.${String(body.chain)}.json` : `nansen/${endpoint}/${address}.json`;
    return { provider: "nansen", endpoint, rel };
  }
  if (url.hostname === "api.zerion.io") {
    const m = /^\/v1\/wallets\/(0x[0-9a-fA-F]{40})\/(transactions|positions)\/$/.exec(url.pathname);
    if (!m) throw missing("zerion", "unknown", url.pathname);
    const testnet = Object.entries(req.headers).some(([k, v]) => k.toLowerCase() === "x-env" && v === "testnet");
    return { provider: "zerion", endpoint: m[2]!, rel: `zerion/${m[2]}/${lower(m[1])}${testnet ? ".testnet" : ""}.json` };
  }
  if (url.hostname === "api.etherscan.io") {
    const q = url.searchParams;
    const chainId = q.get("chainid");
    if (q.get("action") === "getLogs") {
      const borrower = `0x${(q.get("topic3") ?? "").slice(-40)}`.toLowerCase();
      return { provider: "etherscan", endpoint: "logs", rel: `etherscan/logs/${borrower}.${chainId}.json` };
    }
    if (q.get("action") === "tokentx") {
      return { provider: "etherscan", endpoint: "tokentx", rel: `etherscan/tokentx/${lower(q.get("address"))}.${chainId}.json` };
    }
    throw missing("etherscan", q.get("action") ?? "unknown", url.search);
  }
  const call = JSON.parse(req.body ?? "{}") as { method?: string; params?: unknown[] };
  const params = call.params ?? [];
  if (call.method === "eth_call") {
    const tx = params[0] as { to?: string; data?: string };
    const holder = `0x${String(tx.data ?? "").slice(-40)}`.toLowerCase();
    return { provider: "rpc", endpoint: "balance", rel: `rpc/${holder}.json`, rpcKey: `${url.hostname}:balanceOf:${lower(tx.to)}` };
  }
  const endpoint = call.method === "eth_getCode" ? "code" : "nonce";
  return { provider: "rpc", endpoint, rel: `rpc/${lower(params[0])}.json`, rpcKey: `${url.hostname}:${call.method}` };
}

export function fixtureTransport(dir: string = DEFAULT_FIXTURES_DIR): HttpTransport {
  return async (req: HttpRequest): Promise<HttpResponse> => fixtureResponse(req, dir);
}

/** The same answer, synchronously: for driving a recipe the way CRE does (see core/recipe.ts). */
export function fixtureResponse(req: HttpRequest, dir: string = DEFAULT_FIXTURES_DIR): HttpResponse {
  const url = new URL(req.url);
  if (url.hostname === "api.nansen.ai") return nansen(dir, url, req);
  if (url.hostname === "api.zerion.io") return zerion(dir, url, req);
  if (url.hostname === "api.etherscan.io") return etherscan(dir, url, req);
  return rpc(dir, req);
}

// ---------------------------------------------------------------- Nansen

function nansen(dir: string, url: URL, req: HttpRequest): HttpResponse {
  const { endpoint, rel } = locateFixture(req);
  const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  // Every Nansen request schema is closed: refuse what the live API would, the
  // way it does, so a wrong field name fails in fixture mode too.
  const problem = nansenBodyProblem(endpoint, body);
  if (problem && problem.code !== "deprecated_field") {
    return {
      status: 422,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "Unprocessable Entity",
        message: `fixture transport: the ${endpoint} request schema refuses this body`,
        code: problem.code === "unknown_endpoint" ? "invalid_field_value" : problem.code,
        status: 422,
        request_id: "fixture",
        doc_url: "https://docs.nansen.ai",
        param: problem.param ?? undefined,
      }),
    };
  }
  const f = load(dir, rel, "nansen", endpoint);
  if (endpoint !== "transactions" || (f.status ?? 200) !== 200) return respond(f);

  // Apply the date range, source_type, order and page size, as Nansen does.
  const recorded = f.body as { data: Array<Record<string, unknown>>; pagination?: unknown };
  const date = body.date as { from?: string; to?: string } | undefined;
  const from = date?.from ? Date.parse(date.from) : -Infinity;
  const to = date?.to ? Date.parse(date.to) : Infinity;
  const sourceType = (body.filters as { source_type?: string } | undefined)?.source_type;
  const dir0 = ((body.order_by as Array<{ direction?: string }> | undefined)?.[0]?.direction ?? "DESC").toUpperCase();
  const perPage = Number((body.pagination as { per_page?: number } | undefined)?.per_page ?? 20);
  let rows = recorded.data.filter((r) => {
    const t = ts(r.block_timestamp);
    return t >= from && t <= to && (!sourceType || r.source_type === sourceType);
  });
  rows = rows.sort((a, b) => (dir0 === "ASC" ? ts(a.block_timestamp) - ts(b.block_timestamp) : ts(b.block_timestamp) - ts(a.block_timestamp)));
  const page = rows.slice(0, perPage);
  return respond(f, { pagination: { page: 1, per_page: perPage, is_last_page: rows.length <= perPage }, data: page });
}

// ---------------------------------------------------------------- Zerion

function zerion(dir: string, url: URL, req: HttpRequest): HttpResponse {
  const { endpoint: kind, rel } = locateFixture(req);
  const f = load(dir, rel, "zerion", kind);
  if ((f.status ?? 200) !== 200) return respond(f);

  const q = url.searchParams;
  const chains = q.get("filter[chain_ids]")?.split(",").filter(Boolean);
  const recorded = f.body as { data: Array<Record<string, any>>; links?: Record<string, string> };
  const chainOf = (r: Record<string, any>) => String(r.relationships?.chain?.data?.id ?? "");
  let rows = recorded.data.filter((r) => !chains || chains.includes(chainOf(r)));

  if (kind === "positions") return respond(f, { links: { self: url.toString() }, data: rows });

  const ops = q.get("filter[operation_types]")?.split(",").filter(Boolean);
  const min = q.get("filter[min_mined_at]");
  const max = q.get("filter[max_mined_at]");
  const trash = q.get("filter[trash]") ?? "no_filter";
  rows = rows
    .filter((r) => !ops || ops.includes(String(r.attributes?.operation_type)))
    .filter((r) => !min || ts(r.attributes?.mined_at) >= Number(min))
    .filter((r) => !max || ts(r.attributes?.mined_at) <= Number(max))
    .filter((r) => (trash === "only_non_trash" ? r.attributes?.flags?.is_trash !== true : trash === "only_trash" ? r.attributes?.flags?.is_trash === true : true))
    .sort((a, b) => ts(b.attributes?.mined_at) - ts(a.attributes?.mined_at)); // newest first

  const size = Math.min(100, Math.max(1, Number(q.get("page[size]") ?? 100)));
  const after = Number(q.get("page[after]") ?? 0);
  const page = rows.slice(after, after + size);
  const links: Record<string, string> = { self: url.toString() };
  if (after + size < rows.length) {
    const next = new URL(url.toString());
    next.searchParams.set("page[after]", String(after + size));
    links.next = next.toString();
  }
  return respond(f, { links, data: page });
}

// ---------------------------------------------------------------- Etherscan

function etherscan(dir: string, url: URL, req: HttpRequest): HttpResponse {
  const { endpoint, rel } = locateFixture(req);
  const f = load(dir, rel, "etherscan", endpoint);
  if (endpoint !== "tokentx") return respond(f);
  const q = url.searchParams;
  const body = f.body as { status: string; message: string; result: Array<Record<string, string>> | string };
  if (!Array.isArray(body.result)) return respond(f);
  const sort = q.get("sort") === "desc" ? -1 : 1;
  const offset = Number(q.get("offset") ?? 100);
  const rows = [...body.result].sort((a, b) => sort * (Number(a.timeStamp) - Number(b.timeStamp))).slice(0, offset);
  return respond(f, { ...body, result: rows });
}

// ---------------------------------------------------------------- JSON-RPC

function rpc(dir: string, req: HttpRequest): HttpResponse {
  const call = JSON.parse(req.body ?? "{}") as { id?: number };
  const { endpoint, rel, rpcKey } = locateFixture(req);
  const f = load(dir, rel, "rpc", endpoint);
  const result = rpcKey ? f.calls?.[rpcKey] : undefined;
  if (result === undefined) throw missing("rpc", endpoint, `${rel} → ${rpcKey}`);
  return respond(f, { jsonrpc: "2.0", id: call.id ?? 1, result });
}
