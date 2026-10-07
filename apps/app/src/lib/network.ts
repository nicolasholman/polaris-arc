import { type Address, getAddress, zeroAddress } from "viem";
import { api, apiConfigured } from "./api";
import { type ContractName, env } from "./env";
import type { Eip712Domain } from "./sign";

/**
 * The network the Polaris relayer carries, as Polaris for Business reports it
 * (`GET /api/public/network`): contract addresses and the EIP-712 domain of
 * each, from the deployment record. Read once per session.
 *
 * An address set in this build's environment always wins; if the server
 * reports a different one, the app refuses to sign rather than trust either.
 */

export type Network = {
  chainId: number;
  explorerUrl: string;
  contracts: Record<ContractName, Address>;
  domains: Record<ContractName, Eip712Domain>;
  /**
   * CollateralVault, where Boost's dollars are locked (read only: the app
   * shows what is locked). Null where the deployment has none.
   */
  vault: Address | null;
};

type Remote = {
  chainId: number;
  explorerUrl: string;
  /** `split` is null (or absent, from an older API) where PolarisSplit isn't deployed. */
  contracts: { stablecoin: Address; payments: Address; checkout: Address; send: Address; split?: Address | null; loanEngine: Address; vault?: Address | null };
  domains: { stablecoin: Eip712Domain; payments: Eip712Domain; checkout: Eip712Domain; send: Eip712Domain; split?: Eip712Domain | null; loanEngine: Eip712Domain };
};

const REMOTE_NAME: Record<ContractName, Exclude<keyof Remote["contracts"], "vault">> = {
  ausd: "stablecoin",
  payments: "payments",
  checkout: "checkout",
  send: "send",
  split: "split",
  loanEngine: "loanEngine",
};

/** Contracts a deployment may not have yet: reported as the zero address, and the app doesn't offer what needs them. */
const OPTIONAL = new Set<ContractName>(["split"]);

let pending: Promise<Network> | null = null;

export class NetworkMismatch extends Error {
  constructor(name: ContractName) {
    super(`This app is configured for a different ${name} contract than Polaris reports. Nothing was signed.`);
    this.name = "NetworkMismatch";
  }
}

async function load(): Promise<Network> {
  const remote = await api<Remote>("/api/public/network");
  const contracts = {} as Record<ContractName, Address>;
  const domains = {} as Record<ContractName, Eip712Domain>;
  for (const name of Object.keys(REMOTE_NAME) as ContractName[]) {
    const raw = remote.contracts[REMOTE_NAME[name]];
    if (!raw && OPTIONAL.has(name)) {
      contracts[name] = zeroAddress;
      domains[name] = { name: `${name} (not deployed)`, version: "1", chainId: remote.chainId, verifyingContract: zeroAddress };
      continue;
    }
    const reported = getAddress(raw as Address);
    const configured = env.contracts[name];
    if (configured !== zeroAddress && getAddress(configured) !== reported) throw new NetworkMismatch(name);
    contracts[name] = reported;
    domains[name] = { ...(remote.domains[REMOTE_NAME[name]] as Eip712Domain), verifyingContract: reported };
  }
  if (remote.chainId !== env.chainId) throw new Error(`Polaris runs on chain ${remote.chainId}; this app is built for ${env.chainId}.`);
  const vault = remote.contracts.vault && remote.contracts.vault !== zeroAddress ? getAddress(remote.contracts.vault) : null;
  return { chainId: remote.chainId, explorerUrl: remote.explorerUrl, contracts, domains, vault };
}

/** The relayer's network, or null when this build has no Polaris API (and so can't sign). */
export function getNetwork(): Promise<Network> | null {
  if (!apiConfigured()) return null;
  pending ??= load().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
