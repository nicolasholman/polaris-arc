/**
 * A JSON-RPC client for one chain: sent-transaction counts and dollar
 * balances. Public RPCs need no key, so this is always live.
 */

import type { RequestSpec } from "../core/providers/common.ts";
import { ParseError } from "../core/providers/common.ts";
import { parseRpcQuantity, parseRpcResult, rpcRequests } from "../core/providers/rpc.ts";
import { ProviderClient, type ClientOptions } from "./client.ts";
import { jsonBody, ProviderError, statusError, type HttpRequest } from "./http.ts";

export class RpcClient extends ProviderClient {
  readonly url: string;
  readonly chainId: number;

  constructor(url: string, chainId: number, opts: ClientOptions = {}) {
    super(opts, { minIntervalMs: 50, provider: "rpc" });
    this.url = url;
    this.chainId = chainId;
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
        throw new ProviderError({ provider: "rpc", endpoint: spec.endpoint, status: res.status, code: "parse_error", message: err.message, retryable: false });
      }
      throw err;
    }
  }

  /** Transactions this address has sent: its nonce. 0 for gasless accounts. */
  async transactionCount(address: string): Promise<number> {
    const n = await this.call(rpcRequests.transactionCount(this.url, address), parseRpcQuantity);
    return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
  }

  /** `token.balanceOf(holder)`, raw base units. */
  balanceOf(token: string, holder: string): Promise<bigint> {
    return this.call(rpcRequests.balanceOf(this.url, token, holder), parseRpcQuantity);
  }

  /** True when the address holds code (a contract wallet, whose nonce is not activity). */
  async isContract(address: string): Promise<boolean> {
    const code = await this.call(rpcRequests.code(this.url, address), parseRpcResult);
    return typeof code === "string" && code !== "0x" && code !== "0x0";
  }
}
