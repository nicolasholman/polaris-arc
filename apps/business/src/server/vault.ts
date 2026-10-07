import "server-only";

import { getAddress, type Address } from "viem";

import { collateralVaultAbi } from "./chain/abis";
import { publicClient } from "./chain/client";
import type { ChainConfig } from "./env";
import { DOMAIN_NAMES, type Domain } from "./relayer/typed-data";

/**
 * Whether the deployment's CollateralVault takes `withdrawWithSig` (a
 * borrower taking dollars out of Boost with a signature the relayer carries),
 * and the EIP-712 domain it signs under.
 *
 * Read from the vault itself, not the deployment record: a vault built
 * before signed withdrawal (Monad testnet's of 28 Sep 2026, still deployed
 * while the testnet contracts are frozen) has no `eip712Domain()`, so the
 * call reverts and the answer is null: "not available on this network".
 * A vault that answers must name itself ("CollateralVault", version "1") on
 * this chain at its own address, or it is treated the same way.
 *
 * A yes is kept for the vault's address (code doesn't change); a no is asked
 * again next time, so a flaky RPC can't switch the feature off for long.
 */

const known = new Map<Address, Domain>();

export async function vaultWithdrawDomain(chain: ChainConfig): Promise<Domain | null> {
  const vault = chain.contracts.vault;
  if (!vault) return null;
  const cached = known.get(vault);
  if (cached) return cached;
  let d: readonly [string, string, string, bigint, Address, string, readonly bigint[]];
  try {
    d = (await publicClient().readContract({ address: vault, abi: collateralVaultAbi, functionName: "eip712Domain" })) as typeof d;
  } catch {
    return null;
  }
  const [, name, version, chainId, verifyingContract] = d;
  if (name !== DOMAIN_NAMES.vault || version !== "1" || Number(chainId) !== chain.id || getAddress(verifyingContract) !== getAddress(vault)) return null;
  const domain: Domain = { name, version, chainId: chain.id, verifyingContract: getAddress(vault) };
  known.set(vault, domain);
  return domain;
}

export function resetVaultForTests(): void {
  known.clear();
}
