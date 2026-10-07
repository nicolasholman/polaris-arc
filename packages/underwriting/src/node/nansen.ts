/**
 * The Nansen profiler client. `NANSEN_API_KEY` makes it live; without it, it
 * is not configured and every call fails with `not_configured`.
 *
 * Every method throws a ProviderError on failure, with Nansen's own error code
 * where there is one (`insufficient_credits`, `rate_limit_exceeded`, ...), so
 * the collector can fall back to Zerion. An empty first-funder is not a
 * failure: it returns null.
 */

import type { Funder } from "../core/types.ts";
import type { RequestSpec } from "../core/providers/common.ts";
import { ParseError } from "../core/providers/common.ts";
import {
  nansenRequests,
  parseCounterparties,
  parseCurrentBalanceStables,
  parseFirstFunder,
  parseLabels,
  classifyNansenFailure,
  parseOldestTransaction,
  parsePnlSummary,
  parseRelatedWallets,
} from "../core/providers/nansen.ts";
import { ProviderClient, type ClientOptions } from "./client.ts";
import { jsonBody, ProviderError, type HttpRequest, type HttpResponse } from "./http.ts";

export class NansenClient extends ProviderClient {
  constructor(opts: ClientOptions = {}) {
    // Free plan: 15 requests a second.
    super(opts, { minIntervalMs: 70, provider: "nansen" });
  }

  protected authorize(req: HttpRequest): HttpRequest {
    return { ...req, headers: { ...req.headers, apikey: this.apiKey! } };
  }

  private async call<T>(spec: RequestSpec, parse: (body: unknown) => T): Promise<T> {
    const res = await this.request(spec);
    const body = jsonBody(spec, res);
    if (res.status !== 200) throw nansenError(spec, res, body);
    try {
      return parse(body);
    } catch (err) {
      if (err instanceof ParseError) {
        throw new ProviderError({
          provider: "nansen",
          endpoint: spec.endpoint,
          status: res.status,
          code: "parse_error",
          message: err.message,
          retryable: false,
        });
      }
      throw err;
    }
  }

  /** 1 credit. The first address to send native gas, across chains; null when none is attributed. */
  firstFunder(address: string): Promise<Funder | null> {
    return this.call(nansenRequests.firstFunder(address), parseFirstFunder);
  }

  /** 1 credit. Wallets related to `address` on one chain, excluding `exclude`. */
  relatedWallets(address: string, chain: string, exclude: readonly string[] = []) {
    return this.call(nansenRequests.relatedWallets(address, chain), (b) => parseRelatedWallets(b, [address, ...exclude]));
  }

  /** 1 credit. Dollars held, in 6-decimal base units, from Nansen's float balances. */
  currentBalanceStables(address: string, chain = "all"): Promise<number> {
    return this.call(nansenRequests.currentBalance(address, chain), parseCurrentBalanceStables);
  }

  /** 1 credit. The oldest transaction in a range (optionally of one source type), or null. */
  oldestTransaction(address: string, chain: string, fromUnix: number, toUnix: number, sourceType?: string): Promise<number | null> {
    return this.call(
      nansenRequests.transactions(address, chain, fromUnix, toUnix, { sourceType, perPage: 1, direction: "ASC" }),
      parseOldestTransaction,
    );
  }

  /** 5 credits. Counterparties in a range, optionally only those with given labels (e.g. "Exchange"). */
  counterparties(address: string, chain: string, fromUnix: number, toUnix: number, includeLabels?: string[]) {
    return this.call(nansenRequests.counterparties(address, chain, fromUnix, toUnix, { includeLabels }), parseCounterparties);
  }

  /** 1 credit. Realized PnL and win rate. Context only; not a Facts field. */
  pnlSummary(address: string, chain: string, fromUnix: number, toUnix: number) {
    return this.call(nansenRequests.pnlSummary(address, chain, fromUnix, toUnix), parsePnlSummary);
  }

  /** 100 credits, key only. Nansen's labels for an address. */
  labels(address: string, chain = "all") {
    return this.call(nansenRequests.labels(address, chain), parseLabels);
  }
}

function nansenError(spec: RequestSpec, res: HttpResponse, body: unknown): ProviderError {
  const { code, detail } = classifyNansenFailure(res.status, body);
  return new ProviderError({ provider: "nansen", endpoint: spec.endpoint, status: res.status, code, message: detail, retryable: false });
}
