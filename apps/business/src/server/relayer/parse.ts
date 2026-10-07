import "server-only";

import { getAddress, isAddress, parseSignature, zeroAddress, type Address, type Hex } from "viem";

import { HttpError } from "../http";

/** Field parsers for relay requests: each names the field it refuses. */

export function bad(param: string, message: string): never {
  throw new HttpError(400, "invalid_request", message, { param });
}

export function field(body: Record<string, unknown>, path: string): unknown {
  let cur: unknown = body;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function address(body: Record<string, unknown>, path: string): Address {
  const v = field(body, path);
  if (typeof v !== "string" || !isAddress(v, { strict: false })) bad(path, `${path} must be an address.`);
  const a = getAddress(v);
  if (a === zeroAddress) bad(path, `${path} can't be the zero address.`);
  return a;
}

/** A uint256 as a decimal string (or a safe integer). */
export function uint(body: Record<string, unknown>, path: string, { max }: { max?: bigint } = {}): bigint {
  const v = field(body, path);
  let n: bigint;
  if (typeof v === "string" && /^\d{1,78}$/.test(v)) n = BigInt(v);
  else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) n = BigInt(v);
  else bad(path, `${path} must be a whole number, as a decimal string.`);
  if (n >= 2n ** 256n) bad(path, `${path} is too large.`);
  if (max !== undefined && n > max) bad(path, `${path} is too large.`);
  return n;
}

export function bytes32(body: Record<string, unknown>, path: string): Hex {
  const v = field(body, path);
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) bad(path, `${path} must be 32 bytes of hex.`);
  return v.toLowerCase() as Hex;
}

/** A 65-byte r ‖ s ‖ v signature. */
export function signature(body: Record<string, unknown>, path: string): Hex {
  const v = field(body, path);
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(v)) bad(path, `${path} must be a 65-byte signature (0x + 130 hex characters).`);
  return v as Hex;
}

export function text(body: Record<string, unknown>, path: string, { max = 200 } = {}): string {
  const v = field(body, path);
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(path, `${path} must be 1 to ${max} characters.`);
  return v;
}

export function optionalText(body: Record<string, unknown>, path: string): string | undefined {
  const v = field(body, path);
  return v === undefined || v === null ? undefined : text(body, path);
}

/** v, r, s for the contracts that take a split signature. */
export function vrs(sig: Hex): { v: number; r: Hex; s: Hex } {
  const parsed = parseSignature(sig);
  const v = parsed.v !== undefined ? Number(parsed.v) : parsed.yParity + 27;
  return { v, r: parsed.r, s: parsed.s };
}

/** Refuse a deadline in the past or absurdly far ahead (a signature should be short-lived). */
export function deadline(value: bigint, path: string, { maxAheadSeconds = 24 * 3600, nowSeconds = Math.floor(Date.now() / 1000) } = {}): bigint {
  if (value <= BigInt(nowSeconds)) throw new HttpError(400, "signature_expired", "That confirmation expired. Try again.", { param: path });
  if (value > BigInt(nowSeconds + maxAheadSeconds)) bad(path, `${path} is too far in the future.`);
  return value;
}
