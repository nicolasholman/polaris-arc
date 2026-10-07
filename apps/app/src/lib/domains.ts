import { type Address, zeroAddress } from "viem";
import { ApiError, NOT_CONFIGURED_MESSAGE } from "./api";
import { type ContractName, env } from "./env";
import { getNetwork } from "./network";
import type { Eip712Domain } from "./sign";

/**
 * The EIP-712 domain for each verifying contract, read once per session from
 * Polaris for Business's deployment record (`network.ts`), which checks it
 * against any address this build pins. Every signature the app makes starts
 * here, so a build without `NEXT_PUBLIC_POLARIS_API_URL` can't sign anything:
 * there is no domain to sign under.
 *
 * Pages call `prefetchDomains` on mount so the Face ID click handler never
 * waits on the network before the ceremony starts (WebKit wants the passkey
 * call to begin inside the user gesture).
 */

const cache = new Map<ContractName, Promise<Eip712Domain>>();

/** The address this build was configured with (zero when unset; see `resolveContract`). */
export function contractAddress(name: ContractName): Address {
  return env.contracts[name];
}

/** The contract's address: the one Polaris reports, else this build's. */
export async function resolveContract(name: ContractName): Promise<Address> {
  const network = getNetwork();
  if (network) return (await network).contracts[name];
  return env.contracts[name];
}

export function isConfigured(name: ContractName): boolean {
  return env.contracts[name] !== zeroAddress || getNetwork() !== null;
}

export function getDomain(name: ContractName): Promise<Eip712Domain> {
  const network = getNetwork();
  if (!network) return Promise.reject(new ApiError(0, "not_configured", NOT_CONFIGURED_MESSAGE));
  let pending = cache.get(name);
  if (!pending) {
    // Don't cache a failure: the next attempt reads again.
    pending = network
      .then((n) => n.domains[name])
      .catch((error: unknown) => {
        cache.delete(name);
        throw error;
      });
    cache.set(name, pending);
  }
  return pending;
}

export function prefetchDomains(...names: ContractName[]): void {
  for (const name of names) void getDomain(name).catch(() => undefined);
}
