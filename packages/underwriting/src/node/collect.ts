/**
 * Gather evidence for one underwriting in Node, by driving the core's recipe
 * (core/recipe.ts) with the provider clients.
 *
 * The recipe decides what to ask and how to read each answer, including every
 * fallback, and is the same code the CRE workflow runs. This module only sends:
 * each batch concurrently, through the client for its provider, which adds the
 * key, retries, rate-limits and caches. A provider without its key answers
 * every request `not_configured` without sending it, and the recipe moves on
 * to the next source.
 */

import type { RequestSpec } from "../core/providers/common.ts";
import {
  accountRecipe,
  linkedRecipe,
  runAsync,
  type Collected,
  type Issue,
  type RecipeOptions,
  type Reply,
} from "../core/recipe.ts";
import type { Address } from "../core/types.ts";
import type { EtherscanClient } from "./etherscan.ts";
import { ProviderError } from "./http.ts";
import type { NansenClient } from "./nansen.ts";
import type { RpcClient } from "./rpc.ts";
import type { ZerionClient } from "./zerion.ts";

export type { Collected, Issue };

export interface Providers {
  nansen: NansenClient;
  zerion: ZerionClient;
  etherscan: EtherscanClient;
  /** Monad testnet, where Polaris accounts live. */
  accountRpc: RpcClient;
  /** Chains whose nonces count as a linked wallet's sent transactions. */
  historyRpcs: RpcClient[];
}

/** Recipe options; the RPC endpoints come from the providers. */
export type CollectOptions = Omit<RecipeOptions, "accountRpcUrl" | "historyRpcUrls">;

/** A sender for `runAsync`: each request through its provider's client, as a Reply. */
export function sender(p: Providers): (spec: RequestSpec) => Promise<Reply> {
  const rpcByUrl = new Map([p.accountRpc, ...p.historyRpcs].map((c) => [c.url, c]));
  return async (spec) => {
    const client =
      spec.provider === "nansen" ? p.nansen : spec.provider === "zerion" ? p.zerion : spec.provider === "etherscan" ? p.etherscan : (rpcByUrl.get(spec.url) ?? p.accountRpc);
    try {
      const res = await client.execute(spec);
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        return { ok: false, code: "parse_error", retryable: false, retryAfterMs: null, message: `${spec.provider}.${spec.endpoint}: response is not JSON` };
      }
      return { ok: true, status: res.status, body, headers: res.headers };
    } catch (err) {
      if (err instanceof ProviderError) {
        return { ok: false, code: err.code, retryable: err.retryable, retryAfterMs: err.retryAfterMs, message: err.message };
      }
      return { ok: false, code: "error", retryable: true, retryAfterMs: null, message: `${spec.provider}.${spec.endpoint}: ${(err as Error).message}` };
    }
  };
}

function recipeOptions(p: Providers, o: CollectOptions): RecipeOptions {
  return { ...o, accountRpcUrl: p.accountRpc.url, historyRpcUrls: p.historyRpcs.map((c) => c.url) };
}

export function collectAccount(address: Address, p: Providers, o: CollectOptions): Promise<Collected> {
  return runAsync(accountRecipe(address, recipeOptions(p, o)), sender(p));
}

export function collectLinked(address: Address, p: Providers, o: CollectOptions): Promise<Collected> {
  return runAsync(linkedRecipe(address, recipeOptions(p, o)), sender(p));
}
