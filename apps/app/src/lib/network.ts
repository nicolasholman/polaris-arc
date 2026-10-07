import { type Address, getAddress, zeroAddress } from "viem";
import { api, apiConfigured } from "./api";
import { type ContractName, env } from "./env";
import { type ArcRates, type CcipInfo, type GatewayInfo, parseCcip, parseGateway, parseRates } from "./cross-chain.ts";
import type { Eip712Domain } from "./sign";

/**
 * The network the Polaris relayer carries, as Polaris for Business reports it
 * (`GET /api/public/network`): contract addresses and the EIP-712 domain of
 * each, from the deployment record. Read once per session.
 *
 * The tokens' domains come from here too: Circle's USDC and EURC don't
 * implement ERC-5267 `eip712Domain()`, so they are never read from the token
 * (USDC is `{ name: "USDC", version: "2" }`, EURC `{ name: "EURC", version: "2" }`).
 *
 * An address set in this build's environment always wins; if the server
 * reports a different one, the app refuses to sign rather than trust either.
 */

/** A chain Circle's CCTP V2 burns USDC on, to mint it on Arc (domain 26). */
export type CctpSource = {
  chainId: number;
  name: string;
  /** CCTP domain id (Ethereum 0, Avalanche 1, Optimism 2, Arbitrum 3, Base 6, …). */
  domain: number;
  usdc: Address;
  tokenMessengerV2: Address;
  rpcUrl: string;
  explorerUrl: string;
};

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
  /** Euros: EURC and the PolarisSend that escrows it. Null where the deployment has neither (a local chain). */
  euro: { eurc: Address; sendEurc: Address | null } | null;
  /** Add money from another chain (CCTP V2). Null where Polaris doesn't relay CCTP mints (a local chain). */
  cctp: {
    arcDomain: number;
    sources: CctpSource[];
    fastTransfer: boolean;
    /** PolarisCctpHookReceiver on Arc: pays an order from a hooked burn (depositForBurnWithHook). Null where not deployed. */
    hookReceiver: Address | null;
  } | null;
  /** Circle Gateway: a unified USDC balance on other chains, spent on Arc in about a second. Null where the API has none. */
  gateway: GatewayInfo | null;
  /** Chainlink CCIP: pay an order on Arc in one transaction on a source chain. `sources` is empty until a PolarisCCIPSender is deployed. */
  ccip: CcipInfo | null;
  /** Chainlink Data Feeds on Arc (EURC / USD, EUR / USD, USDC / USD): display only. */
  rates: ArcRates | null;
};

type Remote = {
  chainId: number;
  explorerUrl: string;
  /** Optional members are null (or absent, from an older API) where the deployment doesn't have them. */
  contracts: {
    stablecoin: Address;
    eurc?: Address | null;
    payments: Address;
    checkout: Address;
    send: Address;
    sendEurc?: Address | null;
    split?: Address | null;
    loanEngine: Address;
    vault?: Address | null;
  };
  domains: {
    stablecoin: Eip712Domain;
    eurc?: Eip712Domain | null;
    payments: Eip712Domain;
    checkout: Eip712Domain;
    send: Eip712Domain;
    sendEurc?: Eip712Domain | null;
    split?: Eip712Domain | null;
    loanEngine: Eip712Domain;
  };
  circle?: { cctpDomain: number } | null;
  cctp?: { sources: CctpSource[]; fastTransfer?: boolean; hookReceiver?: string | null } | null;
  /** Newer APIs only; read defensively (lib/cross-chain.ts). */
  gateway?: unknown;
  ccip?: unknown;
  rates?: unknown;
};

const REMOTE_NAME: Record<ContractName, Exclude<keyof Remote["contracts"], "vault">> = {
  usdc: "stablecoin",
  eurc: "eurc",
  payments: "payments",
  checkout: "checkout",
  send: "send",
  sendEurc: "sendEurc",
  split: "split",
  loanEngine: "loanEngine",
};

/** Contracts a deployment may not have: reported as the zero address, and the app doesn't offer what needs them. */
const OPTIONAL = new Set<ContractName>(["split", "eurc", "sendEurc"]);

/** Arc's CCTP domain. */
export const ARC_CCTP_DOMAIN = 26;

let pending: Promise<Network> | null = null;

export class NetworkMismatch extends Error {
  constructor(name: ContractName) {
    super(`This app is configured for a different ${name} contract than Polaris reports. Nothing was signed.`);
    this.name = "NetworkMismatch";
  }
}

function cctpSource(s: CctpSource): CctpSource | null {
  try {
    return { ...s, usdc: getAddress(s.usdc), tokenMessengerV2: getAddress(s.tokenMessengerV2), explorerUrl: s.explorerUrl.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

function hookReceiver(raw: unknown): Address | null {
  if (typeof raw !== "string" || raw === zeroAddress) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

/** The API's network as the app keeps it. Exported for tests. */
export function toNetwork(remote: Remote): Network {
  const contracts = {} as Record<ContractName, Address>;
  const domains = {} as Record<ContractName, Eip712Domain>;
  for (const name of Object.keys(REMOTE_NAME) as ContractName[]) {
    const raw = remote.contracts[REMOTE_NAME[name]];
    const domain = remote.domains[REMOTE_NAME[name]];
    if ((!raw || raw === zeroAddress || !domain) && OPTIONAL.has(name)) {
      contracts[name] = zeroAddress;
      domains[name] = { name: `${name} (not deployed)`, version: "1", chainId: remote.chainId, verifyingContract: zeroAddress };
      continue;
    }
    const reported = getAddress(raw as Address);
    const configured = env.contracts[name];
    if (configured !== zeroAddress && getAddress(configured) !== reported) throw new NetworkMismatch(name);
    contracts[name] = reported;
    domains[name] = { ...(domain as Eip712Domain), verifyingContract: reported };
  }
  if (remote.chainId !== env.chainId) throw new Error(`Polaris runs on chain ${remote.chainId}; this app is built for ${env.chainId}.`);
  const vault = remote.contracts.vault && remote.contracts.vault !== zeroAddress ? getAddress(remote.contracts.vault) : null;
  const euro = contracts.eurc !== zeroAddress ? { eurc: contracts.eurc, sendEurc: contracts.sendEurc !== zeroAddress ? contracts.sendEurc : null } : null;
  const sources = (remote.cctp?.sources ?? []).map(cctpSource).filter((s): s is CctpSource => s !== null);
  const cctp =
    remote.cctp && sources.length
      ? {
          arcDomain: remote.circle?.cctpDomain ?? ARC_CCTP_DOMAIN,
          sources,
          fastTransfer: Boolean(remote.cctp.fastTransfer),
          hookReceiver: hookReceiver(remote.cctp.hookReceiver),
        }
      : null;
  return {
    chainId: remote.chainId,
    explorerUrl: remote.explorerUrl,
    contracts,
    domains,
    vault,
    euro,
    cctp,
    gateway: parseGateway(remote.gateway),
    ccip: parseCcip(remote.ccip),
    rates: parseRates(remote.rates),
  };
}

async function load(): Promise<Network> {
  return toNetwork(await api<Remote>("/api/public/network"));
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
