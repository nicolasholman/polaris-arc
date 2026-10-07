import "server-only";

import type { Account, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getConfig, type ActivatorConfig, type RelayerConfig } from "../env";
import { getPrivy } from "../privy";

/**
 * Who signs the relayer's transactions.
 *
 * - `privy` (production): a Privy server wallet. Privy signs
 *   (`eth_signTransaction`) under the relayer policy, authorised by the
 *   relayer key quorum's P-256 key, and we broadcast to our own RPC
 *   (research §4.3, route B): it works on any EVM chain and lets us set the
 *   gas limit, which Monad bills in full.
 * - `local` (development): a raw key on a local Hardhat node, held to the
 *   same allow-list by `checkRelayerCall` before every signature.
 *
 * Both are viem accounts, so everything downstream is identical.
 */

export type RelayerAccount = { kind: "local" | "privy"; address: Address; account: Account };

async function privyAccount(walletId: string, address: Address, authorizationKey: string): Promise<Account> {
  const privy = getPrivy();
  if (!privy) throw new Error("The Privy relayer needs PRIVY_APP_ID and PRIVY_APP_SECRET.");
  // Loaded lazily: `@privy-io/node/viem` pulls in viem internals we only need here.
  const { createViemAccount } = await import("@privy-io/node/viem");
  return createViemAccount(privy, {
    walletId,
    address,
    authorizationContext: { authorization_private_keys: [authorizationKey] },
  }) as unknown as Account;
}

async function accountFor(config: RelayerConfig | ActivatorConfig): Promise<RelayerAccount | null> {
  if (config.mode === "local") {
    const account = privateKeyToAccount(config.privateKey);
    return { kind: "local", address: account.address, account };
  }
  if (config.mode === "privy") {
    return { kind: "privy", address: config.address, account: await privyAccount(config.walletId, config.address, config.authorizationKey) };
  }
  return null;
}

let relayer: Promise<RelayerAccount | null> | null = null;
let activator: Promise<RelayerAccount | null> | null = null;

/** The relayer, or null when RELAYER_MODE is off. */
export function getRelayerAccount(): Promise<RelayerAccount | null> {
  relayer ??= accountFor(getConfig().relayer).catch((error) => {
    relayer = null;
    throw error;
  });
  return relayer;
}

/** The MerchantRegistry owner that activates merchants, or null when REGISTRY_ACTIVATOR is off. */
export function getActivatorAccount(): Promise<RelayerAccount | null> {
  activator ??= accountFor(getConfig().activator).catch((error) => {
    activator = null;
    throw error;
  });
  return activator;
}

export function resetSignersForTests(): void {
  relayer = null;
  activator = null;
}
