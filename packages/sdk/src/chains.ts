import { DEPLOYMENTS, type DeploymentRecord } from "./deployments.js";
import { configurationError } from "./errors.js";
import type { Address, ContractName } from "./types.js";

/**
 * Chain presets. `ARC_TESTNET` and `ARC` are what 0.3 is for; `SEPOLIA`
 * is the 0.2 deployment, kept so existing integrations keep working.
 *
 * Polaris contract addresses come from `deployments.ts`, which is generated
 * from packages/contracts/deployments. Until a network is deployed they are
 * the zero address and `assertDeployed` refuses to use them.
 */

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * The 0.2 shape (`typeof SEPOLIA`), still accepted everywhere a chain is.
 * Anything missing from it is treated as not deployed.
 */
export interface PolarisContracts {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  /** The dollar token: USDC on Arc (6 decimals), MockUSDC on the 0.2 Sepolia deployment. */
  stablecoin: string;
  loanEngine: string;
  scoreManager: string;
  collateralVault: string;
  payments: string;
}

export interface PolarisChain extends PolarisContracts {
  /** A stable identifier: "arc-testnet", "arc", "sepolia". */
  key: string;
  testnet: boolean;
  /** The gas token. On Arc that is USDC itself (18 decimals natively; the ERC-20 view has 6). */
  nativeCurrency: { name: string; symbol: string; decimals: number };
  stablecoin: Address;
  stablecoinSymbol: string;
  stablecoinDecimals: number;
  payments: Address;
  loanEngine: Address;
  scoreManager: Address;
  collateralVault: Address;
  /** PolarisCheckout: opens Pay in 4 plans and subscriptions from signed intents. */
  checkout: Address;
  /** PolarisSend: send by link. */
  send: Address;
  merchantRegistry: Address;
  /**
   * CollectionsReceiver: takes the Polaris keeper's collection reports. The
   * field keeps its 0.3 name for API stability.
   */
  collector: Address;
  batchSettlement: Address;
  features: {
    /** PolarisPayments.payWithAuthorization exists: pay() is a signature, not an approval plus a transaction. */
    payWithAuthorization: boolean;
  };
  /** Where the addresses came from, for error messages and debugging. */
  deployment: { source: string | null; deployedAt: string | null };
}

/**
 * Circle's USDC on Arc: the dollar, and the gas token. The ERC-20 interface
 * has 6 decimals. Its EIP-712 domain is { name: "USDC", version: "2" }, read
 * from `name()` / `version()` and checked against `DOMAIN_SEPARATOR()` (USDC
 * has no ERC-5267 `eip712Domain()`).
 */
export const USDC = {
  arcTestnet: "0x3600000000000000000000000000000000000000",
  arc: "0x3600000000000000000000000000000000000000",
} as const satisfies Record<string, Address>;

/** Circle's EURC on Arc (6 decimals, EIP-712 domain { name: "EURC", version: "2" }). */
export const EURC = {
  arcTestnet: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  arc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
} as const satisfies Record<string, Address>;

/** Arc's gas token is USDC. Gas is paid in it, and through the relayer Polaris pays it. */
const ARC_NATIVE = { name: "USDC", symbol: "USDC", decimals: 18 };

function fromDeployment(record: DeploymentRecord, defaultStablecoin: Address) {
  return {
    ...record.contracts,
    stablecoin: record.stablecoin ?? defaultStablecoin,
    deployment: { source: record.source, deployedAt: record.deployedAt },
  };
}

export const ARC_TESTNET: PolarisChain = Object.freeze({
  key: "arc-testnet",
  chainId: 5042002,
  name: "Arc Testnet",
  rpcUrl: "https://rpc.testnet.arc.io",
  explorer: "https://explorer.testnet.arc.io",
  testnet: true,
  nativeCurrency: ARC_NATIVE,
  stablecoinSymbol: "USDC",
  stablecoinDecimals: 6,
  features: { payWithAuthorization: true },
  ...fromDeployment(DEPLOYMENTS.arcTestnet, USDC.arcTestnet),
});

export const ARC: PolarisChain = Object.freeze({
  key: "arc",
  chainId: 5042,
  name: "Arc",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorer: "https://explorer.arc.io",
  testnet: false,
  nativeCurrency: ARC_NATIVE,
  stablecoinSymbol: "USDC",
  stablecoinDecimals: 6,
  features: { payWithAuthorization: true },
  ...fromDeployment(DEPLOYMENTS.arc, USDC.arc),
});

/**
 * The 0.2 Sepolia deployment. Its PolarisPayments predates
 * payWithAuthorization, so `pay()` here is the 0.2 approve-then-pay flow.
 */
export const SEPOLIA: PolarisChain = Object.freeze({
  key: "sepolia",
  chainId: 11155111,
  name: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
  testnet: true,
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  stablecoin: "0x49C86277a91002c4943837bf20F6ED41976Db09F",
  stablecoinSymbol: "USDC",
  stablecoinDecimals: 6,
  loanEngine: "0x21E9740DDe241f0653F699DAa206AfCE1FA25405",
  scoreManager: "0x81C333942eaEe7d3d724c6C2ea28100511934f3C",
  collateralVault: "0xDb6781ed843Ba07Af3321bB8C3952db643324b98",
  payments: "0x3BD1609abDC915eA9e01A399a26e2B8A2a06243f",
  merchantRegistry: "0xb2eCAD5bE07971deE1be161C39569705186AdFD6",
  batchSettlement: "0xc319dB6F56B3cdA82d2Bcb2eFA75e5c4993B705f",
  checkout: ZERO_ADDRESS,
  send: ZERO_ADDRESS,
  collector: ZERO_ADDRESS,
  features: { payWithAuthorization: false },
  deployment: { source: "packages/contracts/deployments/sepolia.json", deployedAt: "2026-08-06T04:35:49.479Z" },
});

export const CHAINS: readonly PolarisChain[] = [ARC_TESTNET, ARC, SEPOLIA];

export function chainById(chainId: number): PolarisChain | undefined {
  return CHAINS.find((c) => c.chainId === chainId);
}

const CONTRACT_LABELS: Record<ContractName | "stablecoin", string> = {
  payments: "PolarisPayments",
  loanEngine: "PolarisLoanEngine",
  scoreManager: "ScoreManager",
  collateralVault: "CollateralVault",
  checkout: "PolarisCheckout",
  send: "PolarisSend",
  merchantRegistry: "MerchantRegistry",
  collector: "CollectionsReceiver",
  batchSettlement: "BatchSettlement",
  stablecoin: "the dollar token",
};

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isZeroAddress(value: string): boolean {
  return /^0x0{40}$/i.test(value);
}

/**
 * Upgrade a 0.2 contracts object (or a partial override) to a full chain.
 * Fields it lacks are the zero address, so they fail `assertDeployed`.
 */
export function resolveChain(input: PolarisContracts | PolarisChain): PolarisChain {
  if ("key" in input && "features" in input) return input as PolarisChain;
  const known = chainById(input.chainId);
  const base: PolarisChain = known ?? {
    key: `chain-${input.chainId}`,
    chainId: input.chainId,
    name: input.name,
    rpcUrl: input.rpcUrl,
    explorer: input.explorer,
    testnet: true,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    stablecoin: ZERO_ADDRESS,
    stablecoinSymbol: "USD",
    stablecoinDecimals: 6,
    payments: ZERO_ADDRESS,
    loanEngine: ZERO_ADDRESS,
    scoreManager: ZERO_ADDRESS,
    collateralVault: ZERO_ADDRESS,
    checkout: ZERO_ADDRESS,
    send: ZERO_ADDRESS,
    merchantRegistry: ZERO_ADDRESS,
    collector: ZERO_ADDRESS,
    batchSettlement: ZERO_ADDRESS,
    features: { payWithAuthorization: false },
    deployment: { source: null, deployedAt: null },
  };
  return { ...base, ...(input as Partial<PolarisChain>) } as PolarisChain;
}

/**
 * Throw a configuration error unless every named contract has a real address
 * on this chain. This is what stands between an undeployed preset and a
 * signature for a contract that doesn't exist.
 */
export function assertDeployed(chain: PolarisChain, names: ReadonlyArray<ContractName | "stablecoin">): void {
  for (const name of names) {
    const address = (chain as unknown as Record<string, unknown>)[name];
    if (!isAddress(address)) {
      throw configurationError(
        "invalid_contract_address",
        `${CONTRACT_LABELS[name]} on ${chain.name} is not a valid address (${String(address)}).`,
        name,
      );
    }
    if (isZeroAddress(address)) {
      throw configurationError(
        "contract_not_deployed",
        `${CONTRACT_LABELS[name]} is not deployed on ${chain.name} yet: its address in polarispay-sdk's deployments.ts is the zero placeholder` +
          (chain.deployment.source ? ` (from ${chain.deployment.source}).` : ", because packages/contracts has no deployment file for this network.") +
          ` Upgrade polarispay-sdk once it is deployed, or pass your own address: createPolaris({ chain: { ...${presetName(chain)}, ${name}: "0x…" } }).`,
        name,
      );
    }
  }
}

/** True when every named contract has a non-zero address. */
export function isDeployed(chain: PolarisChain, names: ReadonlyArray<ContractName | "stablecoin">): boolean {
  try {
    assertDeployed(chain, names);
    return true;
  } catch {
    return false;
  }
}

function presetName(chain: PolarisChain): string {
  if (chain.chainId === ARC_TESTNET.chainId) return "ARC_TESTNET";
  if (chain.chainId === ARC.chainId) return "ARC";
  if (chain.chainId === SEPOLIA.chainId) return "SEPOLIA";
  return "chain";
}

/** A transaction's page on the chain's explorer. */
export function explorerTxUrl(chain: Pick<PolarisContracts, "explorer">, txHash: string): string {
  return `${chain.explorer.replace(/\/+$/, "")}/tx/${txHash}`;
}
