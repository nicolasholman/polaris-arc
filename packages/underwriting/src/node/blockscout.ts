/**
 * The Blockscout client for Arc's explorer API: a Polaris account's first
 * transaction and its token transfers. Keyless, so always live.
 */

import type { RequestSpec } from "../core/providers/common.ts";
import { ParseError } from "../core/providers/common.ts";
import { blockscoutRequests, parseFirstTransaction, parseTransfers } from "../core/providers/blockscout.ts";
import { ProviderClient, type ClientOptions } from "./client.ts";
import { jsonBody, ProviderError, statusError, type HttpRequest } from "./http.ts";

export class BlockscoutClient extends ProviderClient {
  /** The explorer's Etherscan-style API, e.g. https://explorer.testnet.arc.io/api. */
  readonly apiUrl: string;

  constructor(apiUrl: string, opts: ClientOptions = {}) {
    // Arc's explorer allows about 10 requests a second per client.
    super(opts, { minIntervalMs: 120, provider: "blockscout" });
    this.apiUrl = apiUrl;
  }

  protected authorize(req: HttpRequest): HttpRequest {
    return req;
  }

  private async call<T>(spec: RequestSpec, parse: (body: unknown) => T): Promise<T> {
    const res = await this.request(spec);
    if (res.status !== 200) throw statusError(spec, res);
    const body = jsonBody(spec, res);
    try {
      return parse(body);
    } catch (err) {
      if (err instanceof ParseError) {
        throw new ProviderError({ provider: "blockscout", endpoint: spec.endpoint, status: res.status, code: "parse_error", message: err.message, retryable: false });
      }
      throw err;
    }
  }

  /** Unix seconds of the address's oldest transaction, or null when it has none. */
  firstTransactionAt(address: string): Promise<number | null> {
    return this.call(blockscoutRequests.txlist(this.apiUrl, address, "asc", 1), parseFirstTransaction);
  }

  /** One page of token transfers: the oldest time in it, how many, and how many the address sent. */
  transfers(address: string, sort: "asc" | "desc", pageSize: number) {
    return this.call(blockscoutRequests.tokentx(this.apiUrl, address, sort, pageSize), (b) => parseTransfers(b, address, pageSize));
  }
}
