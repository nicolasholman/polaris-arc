/**
 * The keeper's configuration, from the environment and the deployment record
 * the contracts' deploy script wrote (packages/contracts/deployments/
 * arc-<network>.json). Nothing here has a secret default.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getAddress, type Hex, isAddress, isHex } from "viem";

import type { Backoff } from "./backoff.ts";
import { DEFAULT_LADDER_SECONDS } from "./backoff.ts";

export type Deployment = {
  network: string;
  chainId: number;
  chainName?: string;
  rpcUrl?: string;
  explorerUrl?: string | null;
  contracts: Record<string, { address: Address; blockNumber?: number } | undefined>;
  roles?: { keeper?: Address };
};

export type KeeperConfig = {
  deployment: Deployment;
  deploymentPath: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string | null;
  contracts: {
    usdc: Address;
    eurc: Address | null;
    loanEngine: Address;
    payments: Address;
    checkout: Address;
    scoreManager: Address;
    collections: Address;
    underwriting: Address;
    /** PolarisCCIPReceiver (Chainlink CCIP), when deployed: the keeper settles intents whose CCTP mint landed after the message. */
    ccipReceiver: Address | null;
  };
  /** The block PolarisCCIPReceiver was deployed at (where its log scan starts). */
  ccipFromBlock: bigint;
  /** The keeper's key; null runs read-only (no reports are sent). */
  privateKey: Hex | null;
  callback: { url: string; secret: string } | null;
  /** Shared secret the business signs underwriting requests with; null refuses every request. */
  requestSecret: string | null;
  http: { host: string; port: number };
  collections: {
    intervalSeconds: number;
    recentWindow: number;
    sweepWindow: number;
    maxTasksPerReport: number;
    liquidate: boolean;
    backoff: Backoff | null;
  };
  /** Allow a partial underwriting (conservative facts when a source is down). */
  allowPartial: boolean;
};

const here = dirname(fileURLToPath(import.meta.url));

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function int(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.floor(n);
}

export function deploymentPath(): string {
  const file = env("POLARIS_DEPLOYMENT_FILE");
  if (file) return isAbsolute(file) ? file : resolve(process.cwd(), file);
  const name = env("POLARIS_DEPLOYMENT") ?? "arc-testnet";
  const path = join(here, "..", "..", "..", "packages", "contracts", "deployments", `${name}.json`);
  if (!existsSync(path)) throw new Error(`No deployment record at ${path}: deploy the contracts or set POLARIS_DEPLOYMENT_FILE.`);
  return path;
}

export function loadConfig(): KeeperConfig {
  const path = deploymentPath();
  const deployment = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  const need = (label: string): Address => {
    const a = deployment.contracts[label]?.address;
    if (!a || !isAddress(a)) throw new Error(`The deployment record has no ${label}`);
    return getAddress(a);
  };
  const maybe = (label: string): Address | null => {
    const a = deployment.contracts[label]?.address;
    return a && isAddress(a) ? getAddress(a) : null;
  };
  const keyRaw = env("POLARIS_KEEPER_PRIVATE_KEY");
  let privateKey: Hex | null = null;
  if (keyRaw) {
    const k = (keyRaw.startsWith("0x") ? keyRaw : `0x${keyRaw}`) as Hex;
    if (!isHex(k) || k.length !== 66) throw new Error("POLARIS_KEEPER_PRIVATE_KEY must be a 32-byte hex key");
    privateKey = k;
  }
  const api = env("POLARIS_API_URL")?.replace(/\/+$/, "");
  const secret = env("POLARIS_KEEPER_CALLBACK_SECRET") ?? null;
  const rpcUrl = env("KEEPER_RPC_URL") ?? deployment.rpcUrl;
  if (!rpcUrl) throw new Error("No RPC: set KEEPER_RPC_URL.");
  const ladder = (env("KEEPER_BACKOFF_LADDER_SECONDS") ?? DEFAULT_LADDER_SECONDS.join(","))
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 60);
  return {
    deployment,
    deploymentPath: path,
    chainId: deployment.chainId,
    rpcUrl,
    explorerUrl: deployment.explorerUrl ?? null,
    contracts: {
      usdc: need("USDC"),
      eurc: maybe("EURC"),
      loanEngine: need("PolarisLoanEngine"),
      payments: need("PolarisPayments"),
      checkout: need("PolarisCheckout"),
      scoreManager: need("ScoreManager"),
      collections: need("CollectionsReceiver"),
      underwriting: need("UnderwritingReceiver"),
      ccipReceiver: maybe("PolarisCCIPReceiver"),
    },
    ccipFromBlock: BigInt(deployment.contracts.PolarisCCIPReceiver?.blockNumber ?? 0),
    privateKey,
    callback: api && secret ? { url: `${api}/api/keeper/callback`, secret } : null,
    requestSecret: secret,
    http: { host: env("KEEPER_HOST") ?? "127.0.0.1", port: int("KEEPER_PORT", 2000) },
    collections: {
      intervalSeconds: Math.max(5, int("KEEPER_COLLECTIONS_INTERVAL_SECONDS", 60)),
      recentWindow: Math.max(1, int("KEEPER_RECENT_WINDOW", 200)),
      sweepWindow: Math.max(0, int("KEEPER_SWEEP_WINDOW", 100)),
      maxTasksPerReport: Math.min(60, Math.max(1, int("KEEPER_MAX_TASKS", 40))),
      liquidate: env("KEEPER_LIQUIDATE") !== "0",
      backoff: env("KEEPER_BACKOFF") === "off" ? null : { ladderSeconds: ladder.length ? ladder : [...DEFAULT_LADDER_SECONDS], windowSeconds: int("KEEPER_BACKOFF_WINDOW_SECONDS", 1800) },
    },
    allowPartial: env("KEEPER_ALLOW_PARTIAL") === "1",
  };
}
