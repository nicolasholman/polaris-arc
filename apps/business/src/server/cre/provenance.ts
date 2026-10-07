import "server-only";

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { underwritingReceiverAbi } from "../chain/abis";
import { publicClient } from "../chain/client";
import { getDb } from "../db";
import type { ChainConfig } from "../env";

/**
 * Who stands behind a CRE report, from the forwarder that delivered it. The
 * app's credit line and score say "Verified by Chainlink CRE" only when a
 * report came through Chainlink's production KeystoneForwarder, which checks
 * the DON's signatures. A report the CRE CLI's simulator sent through
 * Chainlink's public MockKeystoneForwarder carries no DON signature (the
 * receiver trusted it for its transmitter key alone), and a local chain's
 * forwarder is this repository's own mock: those are named for what they
 * are, never "verified".
 *
 *   don         Chainlink's KeystoneForwarder: "Verified by Chainlink CRE"
 *   simulation  Chainlink's MockKeystoneForwarder: "Chainlink CRE (simulated)"
 *   local       a local chain: "CRE workflow, local run"
 *   unknown     any other forwarder, or none known: "CRE workflow report"
 */
export type ReportDelivery = "don" | "simulation" | "local" | "unknown";

export const PROVENANCE_LABEL: Readonly<Record<ReportDelivery, string>> = {
  don: "Verified by Chainlink CRE",
  simulation: "Chainlink CRE (simulated)",
  local: "CRE workflow, local run",
  unknown: "CRE workflow report",
};

/**
 * Chainlink's forwarders, by chain id, verified on chain (docs/research/cre.md
 * §4; `typeAndVersion()` "KeystoneForwarder 1.0.0" and "MockKeystoneForwarder
 * 1.0.0" on Monad testnet, 28 Sep 2026).
 */
export const CHAINLINK_FORWARDERS: Readonly<Record<number, { production: readonly Address[]; simulation: readonly Address[] }>> = {
  10143: {
    production: ["0xF8344CFd5c43616a4366C34E3EEE75af79a74482"],
    simulation: ["0xB9F79d863261869B234c481D1f9A7af84AeAd192"],
  },
};

const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;

/**
 * A local chain: demo:local's 31337, or a node on this machine standing in
 * for Monad testnet (an anvil fork). Its reports come from the workflows'
 * local runner, whatever forwarder the deployment record names.
 */
export function isLocalChain(chain: Pick<ChainConfig, "id" | "rpcUrl">): boolean {
  return chain.id === 31337 || LOCAL_RPC.test(chain.rpcUrl);
}

/**
 * How reports reach the receivers on `chain`, for the Chainlink page: the
 * deployment record's kind, except on a local chain, where the local runner
 * delivers them (a fork keeps Chainlink's MockKeystoneForwarder at its
 * address and the record says "simulation", but `cre workflow simulate`
 * didn't send them).
 */
export function forwarderKindOf(
  recorded: "local" | "simulation" | "production" | undefined,
  chain: Pick<ChainConfig, "id" | "rpcUrl">,
): "local" | "simulation" | "production" | null {
  if (isLocalChain(chain)) return "local";
  return recorded ?? null;
}

/** Pure: the delivery kind of a report the `forwarder` delivered on `chain`. */
export function deliveryOf(forwarder: string | null, chain: Pick<ChainConfig, "id" | "rpcUrl">): ReportDelivery {
  // A local chain can plant a mock at Chainlink's addresses: nothing there is Chainlink's.
  if (isLocalChain(chain)) return "local";
  if (!forwarder || !isAddress(forwarder)) return "unknown";
  const f = getAddress(forwarder);
  const known = CHAINLINK_FORWARDERS[chain.id];
  if (known?.production.some((a) => getAddress(a) === f)) return "don";
  if (known?.simulation.some((a) => getAddress(a) === f)) return "simulation";
  return "unknown";
}

const receiverForwarder = new Map<string, { at: number; value: Address | null }>();
const FORWARDER_TTL_MS = 60_000;

/** Tests: forget what the receivers said. */
export function resetProvenanceForTests(): void {
  receiverForwarder.clear();
}

/**
 * The forwarder that delivered report `txHash`: the one its forwarder
 * `ReportProcessed` named (the chain sync's `cre_runs` record), else the one
 * the underwriting receiver trusts now (`getForwarderAddress()`, cached for a
 * minute), else null.
 */
export async function reportForwarder(txHash: Hex, receiver: Address | null): Promise<Address | null> {
  const run = await getDb().creRuns.get(txHash.toLowerCase());
  if (run?.delivery?.forwarder) return getAddress(run.delivery.forwarder);
  if (!receiver) return null;
  const key = receiver.toLowerCase();
  const hit = receiverForwarder.get(key);
  if (hit && Date.now() - hit.at < FORWARDER_TTL_MS) return hit.value;
  let value: Address | null = null;
  try {
    value = getAddress(
      (await publicClient().readContract({ address: receiver, abi: underwritingReceiverAbi, functionName: "getForwarderAddress" })) as Address,
    );
  } catch {
    value = null;
  }
  receiverForwarder.set(key, { at: Date.now(), value });
  return value;
}
