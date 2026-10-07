/**
 * The Zerion client: Nansen's documented fallback, and the exact source for
 * balances and for savings-and-trading tenure. `ZERION_API_KEY` makes it
 * live; without it, it is not configured and every call fails with
 * `not_configured`.
 *
 * "Not trackable" (a 400 for exchange hot wallets, routers, token contracts)
 * is returned as a known empty, not thrown: Zerion is telling us there is no
 * wallet history to read, and retrying will not change that.
 */

import type { RequestSpec } from "../core/providers/common.ts";
import { ParseError } from "../core/providers/common.ts";
import {
  countedRows,
  isNotTrackable,
  parsePositionsStables,
  parseTransactions,
  zerionAuthorization,
  zerionRequests,
  type ZerionTransactionsQuery,
  type ZerionTxRow,
} from "../core/providers/zerion.ts";
import { ProviderClient, type ClientOptions } from "./client.ts";
import { jsonBody, ProviderError, statusError, type HttpRequest } from "./http.ts";

export class ZerionClient extends ProviderClient {
  constructor(opts: ClientOptions = {}) {
    // Developer plan: 3 requests a second.
    super(opts, { minIntervalMs: 340, provider: "zerion" });
  }

  protected authorize(req: HttpRequest): HttpRequest {
    return { ...req, headers: { ...req.headers, Authorization: zerionAuthorization(this.apiKey!) } };
  }

  private async call<T>(spec: RequestSpec, parse: (body: unknown) => T, empty: T): Promise<{ value: T; notTrackable: boolean }> {
    const res = await this.request(spec);
    const body = jsonBody(spec, res);
    if (isNotTrackable(res.status, body)) return { value: empty, notTrackable: true };
    if (res.status !== 200) throw statusError(spec, res);
    try {
      return { value: parse(body), notTrackable: false };
    } catch (err) {
      if (err instanceof ParseError) {
        throw new ProviderError({ provider: "zerion", endpoint: spec.endpoint, status: res.status, code: "parse_error", message: err.message, retryable: false });
      }
      throw err;
    }
  }

  /** One page of transactions, newest first. */
  async transactions(address: string, q: ZerionTransactionsQuery = {}): Promise<{ rows: ZerionTxRow[]; hasNext: boolean; notTrackable: boolean }> {
    const r = await this.call(zerionRequests.transactions(address, q), parseTransactions, { rows: [], hasNext: false });
    return { ...r.value, notTrackable: r.notTrackable };
  }

  /**
   * "Is there any activity at or before `beforeUnix`?", in one tiny request
   * (`page[size]=1`). Binary-searching these over a few edges dates a wallet
   * in O(1) calls whatever its history length (data.md §3.3).
   */
  async hasActivityBefore(address: string, beforeUnix: number, q: Omit<ZerionTransactionsQuery, "maxMinedAt" | "pageSize"> = {}): Promise<boolean> {
    const page = await this.transactions(address, { trash: "only_non_trash", ...q, maxMinedAt: beforeUnix, pageSize: 1 });
    return countedRows(page).length > 0;
  }

  /** Dollars held, 6-decimal base units, summed exactly. */
  async positionsStables(address: string, q: { testnet?: boolean; chainIds?: string[] } = {}): Promise<{ micros: number; notTrackable: boolean }> {
    const r = await this.call(zerionRequests.positions(address, q), parsePositionsStables, 0);
    return { micros: r.value, notTrackable: r.notTrackable };
  }
}
