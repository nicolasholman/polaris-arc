/**
 * Plain JSON-RPC, where it beats both APIs (data.md §4.1): a sent-transaction
 * count in one call whatever the history length, and exact dollar balances.
 *
 * Inside CRE, balances are EVM reads (`callContract`) and nonces are HTTP
 * POSTs, because `EVMClient` has no nonce method. These builders produce the
 * HTTP form.
 */

import { isObject, lower, ParseError, type RequestSpec } from "./common.ts";

export function rpcRequest(url: string, method: string, params: unknown[], endpoint = method): RequestSpec {
  return {
    provider: "rpc",
    endpoint,
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
}

const word = (address: string) => lower(address).slice(2).padStart(64, "0");

export const rpcRequests = {
  transactionCount: (url: string, address: string) =>
    rpcRequest(url, "eth_getTransactionCount", [lower(address), "latest"], "nonce"),
  /** `balanceOf(address)`, selector 0x70a08231. */
  balanceOf: (url: string, token: string, holder: string) =>
    rpcRequest(url, "eth_call", [{ to: lower(token), data: `0x70a08231${word(holder)}` }, "latest"], "balance"),
  code: (url: string, address: string) => rpcRequest(url, "eth_getCode", [lower(address), "latest"], "code"),
} as const;

/** The `result` of a JSON-RPC response; throws on an error object. */
export function parseRpcResult(body: unknown): unknown {
  if (!isObject(body)) throw new ParseError("rpc: body is not an object");
  if (isObject(body.error)) throw new ParseError(`rpc: ${String(body.error.message ?? "error")}`);
  if (!("result" in body)) throw new ParseError("rpc: no result");
  return body.result;
}

/** A hex quantity (`0x1a`) or a 32-byte word, as a bigint. `0x` reads as zero. */
export function parseRpcQuantity(body: unknown): bigint {
  const r = parseRpcResult(body);
  if (typeof r !== "string" || !/^0x[0-9a-fA-F]*$/.test(r)) throw new ParseError("rpc: result is not hex");
  return r === "0x" ? 0n : BigInt(r);
}
