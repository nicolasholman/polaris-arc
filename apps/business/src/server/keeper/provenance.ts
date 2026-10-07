import "server-only";

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { publicClient } from "../chain/client";
import { getDb } from "../db";
import type { ChainConfig } from "../env";

/**
 * Who stands behind an underwriting decision: the transaction that wrote the
 * report to UnderwritingReceiver, and whether it came from the keeper the
 * receiver trusts (it can't come from anyone else: `submitReport` reverts
 * with NotKeeper). The app links the transaction on Arc's explorer.
 */

export type ReportDelivery = "keeper" | "local" | "unknown";

export const PROVENANCE_LABEL: Readonly<Record<ReportDelivery, string>> = {
  keeper: "Reviewed by the Polaris keeper",
  local: "Reviewed by the Polaris keeper (local chain)",
  unknown: "Polaris keeper report",
};

const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;

export function isLocalChain(chain: Pick<ChainConfig, "id" | "rpcUrl">): boolean {
  return chain.id === 31337 || LOCAL_RPC.test(chain.rpcUrl);
}

/** What the app may call a report sent by `sender`. */
export function deliveryOf(sender: string | null, chain: Pick<ChainConfig, "id" | "rpcUrl" | "keeper">): ReportDelivery {
  if (isLocalChain(chain)) return "local";
  if (!sender || !isAddress(sender)) return "unknown";
  const keeper = chain.keeper?.address;
  return keeper && getAddress(keeper) === getAddress(sender) ? "keeper" : "unknown";
}

/** The sender of a report transaction: from the chain sync's record when it has one, else the chain. */
export async function reportSender(txHash: Hex): Promise<Address | null> {
  const run = await getDb().creRuns.get(txHash.toLowerCase());
  if (run?.delivery?.transmitter) return getAddress(run.delivery.transmitter);
  try {
    const tx = await publicClient().getTransaction({ hash: txHash });
    return tx.from ? getAddress(tx.from) : null;
  } catch {
    return null;
  }
}
