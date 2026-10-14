import "server-only";

import { MIN_PAY_IN_4_CENTS } from "@/lib/data/format";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

/**
 * Server configuration, read once from the environment.
 *
 * Nothing here is sent to a browser. Every value has a safe default for local
 * development; production refuses to start without the ones that protect
 * money or keys (see `assertProductionReady`).
 */

export type Deployment = {
  network: string;
  chainId: number;
  chainName?: string;
  rpcUrl?: string;
  explorerUrl?: string | null;
  contracts: Record<string, { address: Address; abi?: string; kind?: string; blockNumber?: number } | undefined>;
  config?: { minInterval?: number; minPeriod?: number; feeBps?: number; interestRateBps?: number; graceSeconds?: number };
  eip712?: Record<string, { domain: { name?: string; version?: string; chainId?: number; verifyingContract?: Address } } | undefined>;
  demo?: { merchant?: Address; merchantName?: string; merchantPrivateKey?: Hex };
  roles?: { keeper?: Address; relayer?: Address | null };
  /** The Circle contracts on this Arc network (packages/contracts lib/networks.js), null on a local node. */
  circle?: CircleConfig | null;
  /** What the deploy script records about the keeper and its receivers. */
  keeper?: DeploymentKeeper;
  /** Chainlink CCIP on this Arc network: the router, Arc's selector, the source chains and their senders. */
  ccip?: DeploymentCcip | null;
  /** Chainlink Data Feeds on this Arc network (mainnet: USDC / USD, EURC / USD, EUR / USD). */
  feeds?: { usdcUsd?: Address; eurcUsd?: Address; eurUsd?: Address } | null;
};

export type DeploymentCcip = {
  chainSelector: string;
  router: Address;
  explorer?: string;
  receiver?: Address;
  sources?: Array<{ name: string; chainId: number; selector: string; router: Address; usdc: Address; tokenMessengerV2: Address; cctpDomain: number; rpcUrl: string }>;
  senders?: Record<string, { name: string; selector: string; address: Address }>;
};

/** Circle's contracts on Arc, as the deployment record copies them. */
export type CircleConfig = {
  usdc: Address;
  eurc: Address | null;
  usyc?: Address | null;
  cctpDomain: number;
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
  gatewayWallet?: Address;
  gatewayMinter?: Address;
  stableFxEscrow?: Address;
  memo: Address | null;
  multicall3From?: Address;
  irisApiUrl: string;
};

/** The keeper block of the deployment record. */
export type DeploymentKeeper = {
  address?: Address;
  collections?: { receiver?: Address; retry?: { event?: string; view?: string } };
  underwriting?: { receiver?: Address };
  guard?: { contract?: Address };
};

export type ContractAddresses = {
  /** USDC on Arc (MockUSDC on a local node). */
  stablecoin: Address;
  /** EURC on Arc, for euro send-by-link; null where the deployment has none. */
  eurc: Address | null;
  checkout: Address;
  payments: Address;
  send: Address;
  /** PolarisSend on EURC; null where the deployment has none. */
  sendEurc: Address | null;
  /** PolarisSplit, split-the-bill links. */
  split: Address | null;
  loanEngine: Address;
  registry: Address;
  scoreManager: Address;
  collections: Address | null;
  underwriting: Address | null;
  /** CreditGuard: the guard PolarisCheckout.openPlan asks, reading the pool live. */
  guardian: Address | null;
  /** CollateralVault: a secured Pay in 4 line, locked with the borrower's permit (lockWithPermit), relayed. */
  vault: Address | null;
};

export type ChainConfig = {
  id: number;
  name: string;
  rpcUrl: string;
  /**
   * Where the chain sync reads logs (eth_getLogs), when not `rpcUrl`
   * (POLARIS_LOGS_RPC_URL): an indexer's RPC that serves wide block ranges.
   */
  logsRpcUrl: string | null;
  explorerUrl: string;
  contracts: ContractAddresses;
  /** The keeper as deployed: its address and receivers (the deployment record's `keeper` block). */
  keeper: DeploymentKeeper | null;
  /** Circle's contracts on this network (CCTP, Memo, EURC, USYC); null on a local node. */
  circle: CircleConfig | null;
  /** Chainlink CCIP (pay from another chain); null on a local node. */
  ccip: DeploymentCcip | null;
  /** PolarisCctpHookReceiver: pays the order a CCTP V2 burn's hookData names (depositForBurnWithHook). */
  cctpHook: Address | null;
  /** Chainlink Data Feeds on Arc (mainnet); null where none are listed. */
  feeds: { usdcUsd?: Address; eurcUsd?: Address; eurUsd?: Address } | null;
  /** The stablecoin's EIP-712 name and version (USDC on Arc: "USDC", "2"). */
  stablecoinDomain: { name: string; version: string };
  /** EURC's EIP-712 name and version ("EURC", "2"), when the deployment has EURC. */
  eurcDomain: { name: string; version: string } | null;
  /** Shortest instalment interval the loan engine accepts, in seconds. */
  minIntervalSeconds: number;
  minPeriodSeconds: number;
  feeBps: number;
  /**
   * A chain on this machine: a Hardhat node (31337 or 1337). The local
   * registry activator and the local dashboard session need it.
   */
  local: boolean;
  /** Arc mainnet (5042): the raw-key relayer is never allowed here. */
  mainnet: boolean;
  /** The first block with a Polaris contract in it (the deployment's), where per-address history starts. */
  fromBlock?: number | null;
};

export type RelayerConfig =
  | { mode: "off"; reason: string }
  | { mode: "local"; privateKey: Hex }
  | { mode: "privy"; walletId: string; address: Address; authorizationKey: string };

export type ActivatorConfig =
  | { mode: "off" }
  | { mode: "local"; privateKey: Hex }
  | { mode: "privy"; walletId: string; address: Address; authorizationKey: string };

export type ServerConfig = {
  production: boolean;
  chain: ChainConfig | null;
  /** Why the chain isn't configured, for the health route and the setup screen. */
  chainProblem: string | null;
  relayer: RelayerConfig;
  /**
   * What the relayer refuses to spend its gas (USDC) on, whoever asks:
   * - `minTransferUnits`: the smallest USDC transfer or send by link it
   *   carries (also a condition in the Privy policy), so moving 0 USDC
   *   between throwaway keys is not free gas;
   * - `maxGas` and `maxFeePerGasWei`: caps on any one transaction, which the
   *   Privy policy can't express.
   */
  relayerLimits: { minTransferUnits: bigint; maxGas: bigint; maxFeePerGasWei: bigint };
  activator: ActivatorConfig;
  /** Per-merchant Pay in 4 cap set on activation, in USDC base units. */
  activationCapUnits: bigint;
  /**
   * Settlement history a merchant needs before it is activated for Pay in 4
   * automatically: this many Pay-now payments, each from a different payer
   * (MERCHANT_ACTIVATION_MIN_PAYMENTS; 3 in production, 0 in development).
   * A brand-new merchant can take Pay now at once, but can't have a crowd of
   * fresh accounts draw their opening credit lines on it before it has sold
   * anything to anyone.
   */
  activationMinPayers: number;
  payoutSigner: { signerId: string; authorizationKey: string } | null;
  /**
   * The offline admin key quorum that owns our Privy policies
   * (PRIVY_ADMIN_QUORUM_ID, from setup-relayer). Without it a merchant's
   * payout policy is owned by the app, and the app secret alone could
   * rewrite its destination: production refuses to create one.
   */
  adminQuorumId: string | null;
  privyDisabled: boolean;
  /**
   * `pnpm demo:local` only: a signed-in dashboard for the demo merchant
   * without Privy. Set only outside production, on a local chain, with Privy
   * off, from POLARIS_LOCAL_SESSION_TOKEN (32+ random characters, which the
   * dashboard presents as its Bearer token) and POLARIS_LOCAL_SESSION_WALLET.
   */
  localSession: { token: string; wallet: Address } | null;
  keyPepper: string | undefined;
  dbUrl: string;
  /**
   * The hosted checkout: session URLs are `${checkoutOrigin}/pay/${id}`.
   * Null in production until POLARIS_CHECKOUT_ORIGIN is set: links and
   * sessions don't go live on a guessed host.
   */
  checkoutOrigin: string | null;
  /** This server's own public URL; null in production until POLARIS_PUBLIC_URL is set. */
  publicUrl: string | null;
  /** Origins allowed to call /api/relay and /api/public from a browser. */
  appOrigins: string[];
  cronSecret: string | null;
  webhooks: { allowPrivate: boolean; timeoutMs: number };
  sessionTtlSeconds: number;
  payIn4: { installments: number; intervalSeconds: number; minCents: number; maxCents: number };
  receiptTimeoutMs: number;
  /** Background loops (webhooks, chain sync, payouts) in this process. */
  workers: boolean;
  /**
   * The Polaris keeper (services/keeper): where it takes credit review
   * requests (KEEPER_UNDERWRITING_URL, e.g. http://127.0.0.1:2000/underwrite),
   * how far apart this server sends them, and the shared secret both ways are
   * signed with (requests to the keeper, and its callbacks to
   * /api/keeper/callback).
   */
  keeper: { underwritingUrl: string | null; minRequestIntervalMs: number; callbackSecret: string | null };
  /** The underwriting gateway (apps/gateway), which explains an attested decision in the buyer's words. */
  underwriting: { gatewayUrl: string | null; apiToken: string | null };
  /**
   * The Polaris Envio indexer's GraphQL endpoint on Arc (POLARIS_INDEXER_URL,
   * and POLARIS_INDEXER_TOKEN on a paid plan), optional: the Overview's event
   * feed reads it, and the webhook dispatcher reads its `Activity` outbox
   * (webhooks/outbox.ts). Without it the built-in chain sync is the source.
   */
  indexer: { url: string | null; token: string | null };
  /**
   * How many proxies we run in front of this server, each appending to
   * X-Forwarded-For: the client's IP is that many entries from the right
   * (http.ts `clientIp`). 0 means Next is exposed directly.
   */
  trustedProxies: number;
};

const DEFAULT_RPC: Record<number, string> = {
  5042002: "https://rpc.testnet.arc.io",
  5042: "https://rpc.mainnet.arc.io",
  31337: "http://127.0.0.1:8600",
};
const DEFAULT_EXPLORER: Record<number, string> = {
  5042002: "https://explorer.testnet.arc.io",
  5042: "https://explorer.arc.io",
  // A local Hardhat node has no explorer: receipts carry no link.
  31337: "",
};
const CHAIN_NAME: Record<number, string> = { 5042002: "Arc Testnet", 5042: "Arc", 31337: "Local Hardhat" };

/** Arc mainnet's chain id. */
export const ARC_MAINNET_ID = 5042;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function flag(name: string, fallback = false): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function int(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(v)}`);
  return Math.floor(n);
}

function hexKey(name: string): Hex | undefined {
  const v = env(name);
  if (v === undefined) return undefined;
  const key = (v.startsWith("0x") ? v : `0x${v}`) as Hex;
  if (!isHex(key) || key.length !== 66) throw new Error(`${name} must be a 32-byte hex private key`);
  return key;
}

function address(name: string): Address | undefined {
  const v = env(name);
  if (v === undefined) return undefined;
  if (!isAddress(v)) throw new Error(`${name} must be an address`);
  return getAddress(v);
}

/**
 * Where deployment records live, relative to where Next runs (apps/business).
 * Read at runtime, not bundled: the `turbopackIgnore` comments keep Next from
 * tracing the whole repository into the server output.
 */
function deploymentPath(): string | null {
  const file = env("POLARIS_DEPLOYMENT_FILE");
  const cwd = process.cwd();
  if (file) return isAbsolute(file) ? file : resolve(/*turbopackIgnore: true*/ cwd, file);
  const name = env("POLARIS_DEPLOYMENT") ?? "arc-testnet";
  const candidates = [
    join(/*turbopackIgnore: true*/ cwd, "..", "..", "packages", "contracts", "deployments", `${name}.json`),
    join(/*turbopackIgnore: true*/ cwd, "packages", "contracts", "deployments", `${name}.json`),
    join(/*turbopackIgnore: true*/ cwd, "deployments", `${name}.json`),
  ];
  return candidates.find((p) => existsSync(/*turbopackIgnore: true*/ p)) ?? null;
}

export function loadDeployment(): { deployment: Deployment | null; problem: string | null; path: string | null } {
  const path = deploymentPath();
  if (!path) {
    return {
      deployment: null,
      path: null,
      problem: `No deployment record found for ${env("POLARIS_DEPLOYMENT") ?? "arc-testnet"}. Deploy the contracts (pnpm --filter @polarispay/contracts deploy:testnet) or set POLARIS_DEPLOYMENT_FILE.`,
    };
  }
  try {
    const deployment = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")) as Deployment;
    if (!Number.isInteger(deployment.chainId)) throw new Error("chainId missing");
    return { deployment, problem: null, path };
  } catch (error) {
    return { deployment: null, path, problem: `The deployment record at ${path} is unreadable: ${(error as Error).message}` };
  }
}

function contractsFrom(d: Deployment): ContractAddresses {
  const need = (name: string): Address => {
    const a = d.contracts[name]?.address;
    if (!a || !isAddress(a)) throw new Error(`The deployment record has no ${name} address`);
    return getAddress(a);
  };
  const maybe = (name: string): Address | null => {
    const a = d.contracts[name]?.address;
    return a && isAddress(a) ? getAddress(a) : null;
  };
  return {
    stablecoin: need("USDC"),
    eurc: maybe("EURC"),
    checkout: need("PolarisCheckout"),
    payments: need("PolarisPayments"),
    send: need("PolarisSend"),
    sendEurc: maybe("PolarisSendEURC"),
    split: maybe("PolarisSplit"),
    loanEngine: need("PolarisLoanEngine"),
    registry: need("MerchantRegistry"),
    scoreManager: need("ScoreManager"),
    collections: maybe("CollectionsReceiver"),
    underwriting: maybe("UnderwritingReceiver"),
    guardian: maybe("CreditGuard"),
    vault: maybe("CollateralVault"),
  };
}

/** The earliest block a contract in the record was deployed in, or null when the record doesn't say. */
function deployedFrom(d: Deployment): number | null {
  const blocks = Object.values(d.contracts)
    .map((c) => c?.blockNumber)
    .filter((b): b is number => typeof b === "number" && Number.isInteger(b) && b >= 0);
  return blocks.length ? Math.min(...blocks) : null;
}

/** An RPC URL on this machine (loopback), where nothing sent can reach a public chain. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function chainFrom(d: Deployment): ChainConfig {
  const id = d.chainId;
  const stable = d.eip712?.USDC?.domain;
  const eurc = d.eip712?.EURC?.domain;
  const rpcUrl = env("POLARIS_RPC_URL") ?? d.rpcUrl ?? DEFAULT_RPC[id] ?? "";
  const local = id === 31337 || id === 1337;
  return {
    id,
    name: d.chainName ?? CHAIN_NAME[id] ?? `Chain ${id}`,
    rpcUrl,
    logsRpcUrl: env("POLARIS_LOGS_RPC_URL") ?? null,
    explorerUrl: (env("POLARIS_EXPLORER_URL") ?? d.explorerUrl ?? DEFAULT_EXPLORER[id] ?? "").replace(/\/+$/, ""),
    contracts: contractsFrom(d),
    keeper: d.keeper ?? null,
    circle: d.circle ?? null,
    ccip: d.ccip ? { ...d.ccip, receiver: d.contracts.PolarisCCIPReceiver?.address ?? d.ccip.receiver } : null,
    cctpHook: d.contracts.PolarisCctpHookReceiver?.address ? getAddress(d.contracts.PolarisCctpHookReceiver.address) : null,
    feeds: d.feeds ?? null,
    stablecoinDomain: { name: stable?.name ?? "USDC", version: stable?.version ?? "2" },
    eurcDomain: d.contracts.EURC ? { name: eurc?.name ?? "EURC", version: eurc?.version ?? "2" } : null,
    minIntervalSeconds: d.config?.minInterval ?? 3600,
    minPeriodSeconds: d.config?.minPeriod ?? 3600,
    feeBps: d.config?.feeBps ?? 50,
    local,
    mainnet: id === ARC_MAINNET_ID,
    fromBlock: deployedFrom(d),
  };
}

function relayerFrom(chain: ChainConfig | null): RelayerConfig {
  const mode = (env("RELAYER_MODE") ?? (env("PRIVY_RELAYER_WALLET_ID") ? "privy" : "off")).toLowerCase();
  if (!chain) return { mode: "off", reason: "No chain is configured." };
  if (mode === "off") return { mode: "off", reason: "RELAYER_MODE is off. Set it to privy (production) or local (a local node, or Arc testnet knowingly)." };
  if (mode === "local") {
    if (chain.mainnet) throw new Error("RELAYER_MODE=local is never allowed on Arc mainnet: use the Privy relayer.");
    if (!chain.local && !flag("RELAYER_LOCAL_ALLOW_TESTNET")) {
      throw new Error(
        "RELAYER_MODE=local signs with a raw key and is for a local node. On Arc testnet use RELAYER_MODE=privy, or set RELAYER_LOCAL_ALLOW_TESTNET=1 knowingly.",
      );
    }
    const privateKey = hexKey("RELAYER_PRIVATE_KEY");
    if (!privateKey) throw new Error("RELAYER_MODE=local needs RELAYER_PRIVATE_KEY.");
    return { mode: "local", privateKey };
  }
  if (mode === "privy") {
    const walletId = env("PRIVY_RELAYER_WALLET_ID");
    const addr = address("PRIVY_RELAYER_ADDRESS");
    const authorizationKey = env("PRIVY_RELAYER_AUTH_KEY");
    if (!walletId || !addr || !authorizationKey) {
      throw new Error(
        "RELAYER_MODE=privy needs PRIVY_RELAYER_WALLET_ID, PRIVY_RELAYER_ADDRESS and PRIVY_RELAYER_AUTH_KEY (run scripts/privy/setup-relayer.mjs).",
      );
    }
    return { mode: "privy", walletId, address: addr, authorizationKey };
  }
  throw new Error(`RELAYER_MODE must be off, local or privy; got ${JSON.stringify(mode)}`);
}

function activatorFrom(chain: ChainConfig | null): ActivatorConfig {
  const mode = (env("REGISTRY_ACTIVATOR") ?? "off").toLowerCase();
  if (!chain || mode === "off") return { mode: "off" };
  if (mode === "local") {
    if (!chain.local) throw new Error("REGISTRY_ACTIVATOR=local is for a local node only.");
    const privateKey = hexKey("REGISTRY_OWNER_PRIVATE_KEY");
    if (!privateKey) throw new Error("REGISTRY_ACTIVATOR=local needs REGISTRY_OWNER_PRIVATE_KEY.");
    return { mode: "local", privateKey };
  }
  if (mode === "privy") {
    const walletId = env("PRIVY_REGISTRY_WALLET_ID");
    const addr = address("PRIVY_REGISTRY_ADDRESS");
    const authorizationKey = env("PRIVY_REGISTRY_AUTH_KEY");
    if (!walletId || !addr || !authorizationKey) {
      throw new Error("REGISTRY_ACTIVATOR=privy needs PRIVY_REGISTRY_WALLET_ID, PRIVY_REGISTRY_ADDRESS and PRIVY_REGISTRY_AUTH_KEY.");
    }
    return { mode: "privy", walletId, address: addr, authorizationKey };
  }
  throw new Error(`REGISTRY_ACTIVATOR must be off, local or privy; got ${JSON.stringify(mode)}`);
}

function origin(value: string, name: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`${name} must be a URL, got ${JSON.stringify(value)}`);
  }
}

/** A full http(s) URL (path kept), or null when unset. */
function httpUrl(value: string | undefined, name: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must be an http(s) URL`);
  return url.toString().replace(/\/+$/, "");
}

function build(): ServerConfig {
  const production = process.env.NODE_ENV === "production";
  const { deployment, problem } = loadDeployment();
  let chain: ChainConfig | null = null;
  let chainProblem = problem;
  if (deployment) {
    try {
      chain = chainFrom(deployment);
      if (!chain.rpcUrl) {
        chainProblem = `No RPC for chain ${chain.id}: set POLARIS_RPC_URL.`;
        chain = null;
      }
    } catch (error) {
      chainProblem = (error as Error).message;
    }
  }

  // Development defaults to the local apps; production has none, so a
  // missing setting is reported (productionProblems) instead of handing
  // buyers, or the MerchantRegistry, a host that doesn't exist.
  const checkoutRaw = env("POLARIS_CHECKOUT_ORIGIN") ?? (production ? null : "http://localhost:3000");
  const publicRaw = env("POLARIS_PUBLIC_URL") ?? (production ? null : "http://localhost:3100");
  const checkoutOrigin = checkoutRaw ? origin(checkoutRaw, "POLARIS_CHECKOUT_ORIGIN") : null;
  const publicUrl = publicRaw ? origin(publicRaw, "POLARIS_PUBLIC_URL") : null;
  const extraOrigins = (env("POLARIS_APP_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => origin(s, "POLARIS_APP_ORIGINS"));
  const appOrigins = [
    ...new Set([...(checkoutOrigin ? [checkoutOrigin] : []), ...extraOrigins, ...(production ? [] : ["http://localhost:3000"])]),
  ];

  const signerId = env("PRIVY_PAYOUT_SIGNER_ID") ?? env("NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID");
  const signerKey = env("PRIVY_PAYOUT_SIGNER_KEY");

  const payIn4Interval = int("PAY_IN_4_INTERVAL_SECONDS", 7 * 24 * 3600);

  return {
    production,
    chain,
    chainProblem,
    relayer: relayerFrom(chain),
    relayerLimits: {
      minTransferUnits: BigInt(Math.max(1, int("RELAYER_MIN_TRANSFER_UNITS", 100_000))), // $0.10
      maxGas: BigInt(Math.max(21_000, int("RELAYER_MAX_GAS", 3_000_000))),
      maxFeePerGasWei: BigInt(Math.max(1, int("RELAYER_MAX_FEE_GWEI", 1_000))) * 1_000_000_000n,
    },
    activator: activatorFrom(chain),
    activationCapUnits: BigInt(int("MERCHANT_ACTIVATION_CAP_USD", 1_000)) * 1_000_000n,
    activationMinPayers: Math.max(0, int("MERCHANT_ACTIVATION_MIN_PAYMENTS", production ? 3 : 0)),
    payoutSigner: signerId && signerKey ? { signerId, authorizationKey: signerKey } : null,
    adminQuorumId: env("PRIVY_ADMIN_QUORUM_ID") ?? null,
    privyDisabled: flag("POLARIS_DISABLE_PRIVY"),
    localSession: localSessionFrom(production, chain),
    keyPepper: env("POLARIS_KEY_PEPPER"),
    dbUrl: env("POLARIS_DB_URL") ?? `sqlite:${join(/*turbopackIgnore: true*/ process.cwd(), ".data", "polaris.db")}`,
    checkoutOrigin,
    publicUrl,
    appOrigins,
    cronSecret: env("CRON_SECRET") ?? null,
    webhooks: {
      allowPrivate: !production && flag("POLARIS_WEBHOOK_ALLOW_PRIVATE", true),
      timeoutMs: int("POLARIS_WEBHOOK_TIMEOUT_MS", 10_000),
    },
    sessionTtlSeconds: int("POLARIS_SESSION_TTL_SECONDS", 24 * 3600),
    payIn4: {
      installments: 4,
      intervalSeconds: chain ? Math.max(payIn4Interval, chain.minIntervalSeconds) : payIn4Interval,
      minCents: int("PAY_IN_4_MIN_CENTS", MIN_PAY_IN_4_CENTS),
      maxCents: int("PAY_IN_4_MAX_CENTS", 1_000_00),
    },
    receiptTimeoutMs: int("RELAYER_RECEIPT_TIMEOUT_MS", 15_000),
    workers: flag("POLARIS_WORKERS", !production),
    keeper: {
      underwritingUrl: httpUrl(env("KEEPER_UNDERWRITING_URL"), "KEEPER_UNDERWRITING_URL"),
      minRequestIntervalMs: Math.max(0, int("KEEPER_REQUEST_MIN_INTERVAL_MS", 2_000)),
      callbackSecret: env("POLARIS_KEEPER_CALLBACK_SECRET") ?? null,
    },
    underwriting: {
      gatewayUrl: (env("UNDERWRITING_GATEWAY_URL") ?? "").replace(/\/+$/, "") || null,
      apiToken: env("UNDERWRITING_API_TOKEN") ?? null,
    },
    indexer: {
      url: httpUrl(env("POLARIS_INDEXER_URL"), "POLARIS_INDEXER_URL"),
      token: env("POLARIS_INDEXER_TOKEN") ?? null,
    },
    // POLARIS_TRUST_PROXY=1 (the older setting) means one proxy.
    trustedProxies: Math.max(0, int("POLARIS_TRUSTED_PROXIES", flag("POLARIS_TRUST_PROXY") ? 1 : 0)),
  };
}

function localSessionFrom(production: boolean, chain: ChainConfig | null): ServerConfig["localSession"] {
  const token = env("POLARIS_LOCAL_SESSION_TOKEN");
  const wallet = env("POLARIS_LOCAL_SESSION_WALLET");
  if (!token && !wallet) return null;
  // An explicit on-demand recording may use real mainnet with local persistence.
  // It must run in development, publish only a loopback URL, and retain Privy's
  // mainnet relayer. No merchant signing key is sent to the browser.
  const recording = process.env.NODE_ENV === "development" && chain?.mainnet &&
    flag("POLARIS_LOCAL_MAINNET_RECORDING") &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env("POLARIS_PUBLIC_URL") ?? "") &&
    env("RELAYER_MODE") === "privy" && !env("NEXT_PUBLIC_POLARIS_LOCAL_SESSION_KEY");
  if (production || (!recording && (!chain?.local || !flag("POLARIS_DISABLE_PRIVY")))) {
    throw new Error("POLARIS_LOCAL_SESSION_* is for `pnpm demo:local` only, or explicit loopback mainnet recording in development with the Privy relayer; never in production.");
  }
  if (!token || token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("POLARIS_LOCAL_SESSION_TOKEN must be at least 32 random letters, digits, - or _.");
  }
  if (!wallet || !isAddress(wallet)) throw new Error("POLARIS_LOCAL_SESSION_WALLET must be the demo merchant's address.");
  return { token, wallet: getAddress(wallet) };
}

let cached: ServerConfig | null = null;

export function getConfig(): ServerConfig {
  cached ??= build();
  return cached;
}

/** Tests change the environment between cases. */
export function resetConfig(): void {
  cached = null;
}

/** What production needs before it takes money: logged at startup (instrumentation.ts); the health route reports only whether there is any. */
export function productionProblems(config = getConfig()): string[] {
  if (!config.production) return [];
  const problems: string[] = [];
  if (!config.keyPepper) problems.push("POLARIS_KEY_PEPPER is not set: secret keys would be stored as plain SHA-256.");
  if (!config.cronSecret) problems.push("CRON_SECRET is not set: the cron routes are closed.");
  if (config.relayer.mode === "local") problems.push("The relayer signs with a raw key.");
  if (config.payoutSigner && !config.adminQuorumId) {
    problems.push("PRIVY_ADMIN_QUORUM_ID is not set: automatic payout policies would be owned by the app, and the app secret alone could redirect them (they are refused until it is set).");
  }
  if (config.trustedProxies === 0) {
    problems.push("POLARIS_TRUSTED_PROXIES is not set: per-IP rate limits can't tell a client's own X-Forwarded-For from the one our proxy wrote.");
  }
  if (!config.checkoutOrigin) problems.push("POLARIS_CHECKOUT_ORIGIN is not set: payment links and checkout sessions have nowhere to send buyers.");
  if (!config.publicUrl) problems.push("POLARIS_PUBLIC_URL is not set: merchants can't register on Arc (it goes in their registry metadata).");
  return problems;
}

/** The hosted checkout's URL for a link or session id, or null while no checkout origin is configured. */
export function checkoutUrl(id: string, config = getConfig()): string | null {
  return config.checkoutOrigin ? `${config.checkoutOrigin}/pay/${id}` : null;
}

export function explorerTxUrl(hash: string, config = getConfig()): string | null {
  return config.chain?.explorerUrl ? `${config.chain.explorerUrl}/tx/${hash}` : null;
}
