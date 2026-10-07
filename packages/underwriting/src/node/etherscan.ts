/**
 * The Etherscan V2 client: past loans closed by a lender, and the transfer
 * history of a gasless account. `ETHERSCAN_API_KEY` makes it live; without
 * it, it is not configured and every call fails with `not_configured`.
 */

import type { RequestSpec } from "../core/providers/common.ts";
import { ParseError } from "../core/providers/common.ts";
import { etherscanRequests, parseLiquidationCount, parseTokenTransfers } from "../core/providers/etherscan.ts";
import { ProviderClient, type ClientOptions } from "./client.ts";
import { jsonBody, ProviderError, statusError, type HttpRequest } from "./http.ts";

export class EtherscanClient extends ProviderClient {
  constructor(opts: ClientOptions = {}) {
    // Free tier: 3 calls a second.
    super(opts, { minIntervalMs: 340, provider: "etherscan" });
  }

  /** The key rides in the query string; it is added here, after caching keys are taken. */
  protected authorize(req: HttpRequest): HttpRequest {
    return { ...req, url: `${req.url}&apikey=${encodeURIComponent(this.apiKey!)}` };
  }

  private async call<T>(spec: RequestSpec, parse: (body: unknown) => T): Promise<T> {
    const res = await this.request(spec);
    if (res.status !== 200) throw statusError(spec, res);
    const body = jsonBody(spec, res);
    try {
      return parse(body);
    } catch (err) {
      if (err instanceof ParseError) {
        // Etherscan reports a bad key or a rate limit as status "0" inside a 200.
        const rateLimited = /rate limit/i.test(err.message);
        throw new ProviderError({
          provider: "etherscan",
          endpoint: spec.endpoint,
          status: res.status,
          code: rateLimited ? "rate_limited" : "parse_error",
          message: err.message,
          retryable: rateLimited,
        });
      }
      throw err;
    }
  }

  /** Liquidations of `borrower` on one chain, counting only logs from `pools`. */
  liquidationCount(chainId: number, borrower: string, pools: readonly string[]): Promise<number> {
    return this.call(etherscanRequests.liquidationLogs(chainId, borrower), (b) => parseLiquidationCount(b, pools));
  }

  /** The first token transfer's time and the count in one page (up to `offset`). */
  tokenTransfers(chainId: number, address: string, sort: "asc" | "desc", offset: number) {
    return this.call(etherscanRequests.tokenTransfers(chainId, address, sort, offset), parseTokenTransfers);
  }
}
