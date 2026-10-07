// Shared by the Privy setup scripts. Nothing here talks to Privy by itself.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_DIR = resolve(APP_DIR, "..", "..");

/** Parse a dotenv file: KEY=value lines, # comments, optional quotes. */
export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** The environment the business app would see: process env over .env.privy over .env.local. */
export function loadEnv() {
  return {
    ...parseEnvFile(join(APP_DIR, ".env.local")),
    ...parseEnvFile(join(APP_DIR, ".env.privy")),
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "")),
  };
}

export function flag(name) {
  return process.argv.includes(`--${name}`);
}

export function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

/** The deployment record the relayer will serve (packages/contracts/deployments/<name>.json). */
export function loadDeployment(env) {
  const file = env.POLARIS_DEPLOYMENT_FILE
    ? resolve(APP_DIR, env.POLARIS_DEPLOYMENT_FILE)
    : join(REPO_DIR, "packages", "contracts", "deployments", `${option("deployment", env.POLARIS_DEPLOYMENT ?? "monad-testnet")}.json`);
  if (!existsSync(file)) {
    throw new Error(
      `No deployment record at ${file}.\nDeploy first (pnpm --filter @polarispay/contracts deploy:monad), or pass --deployment <name> / POLARIS_DEPLOYMENT_FILE.`,
    );
  }
  const d = JSON.parse(readFileSync(file, "utf8"));
  const at = (name) => {
    const a = d.contracts?.[name]?.address;
    if (!a) throw new Error(`${file} has no ${name} address`);
    return a;
  };
  return {
    file,
    chainId: d.chainId,
    // Whether the record's vault takes withdrawWithSig: written by deploy:monad and redeploy-vault:monad
    // from the vault itself. Monad testnet's vault of 28 Sep 2026 predates it.
    vaultWithdraw: Boolean(d.eip712?.CollateralVault),
    addresses: {
      checkout: at("PolarisCheckout"),
      payments: at("PolarisPayments"),
      send: at("PolarisSend"),
      // Absent from a deployment that predates split-the-bill links: its rules are then left out.
      split: d.contracts?.PolarisSplit?.address ?? null,
      loanEngine: at("PolarisLoanEngine"),
      registry: at("MerchantRegistry"),
      stablecoin: at("Stablecoin"),
      // Optional: a deployment without the vault has no gasless collateral rule.
      vault: d.contracts?.CollateralVault?.address ?? null,
    },
  };
}

/** Append or replace KEY=value lines in apps/business/.env.privy (git-ignored by `.env.*`). */
export function writeEnvPrivy(values) {
  const path = join(APP_DIR, ".env.privy");
  const current = parseEnvFile(path);
  const merged = { ...current, ...values };
  const body = [
    "# Written by scripts/privy/*.mjs. Secrets: never commit this file (it is git-ignored).",
    "# Copy these lines into .env.local, or keep this file: the scripts read both.",
    ...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/**
 * Save the admin key quorum's private key to apps/business/.privy-admin.key
 * (mode 0600, git-ignored), never to stdout: terminal scrollback and CI logs
 * keep what is printed. Refuses to overwrite an earlier key.
 */
export function writeAdminKey(quorumId, privateKey) {
  const path = join(APP_DIR, ".privy-admin.key");
  if (existsSync(path)) throw new Error(`${path} already exists: move that key offline and delete the file first.`);
  const body = [
    "# The Privy admin key quorum's private key. It owns the relayer, registry admin and payout policies.",
    "# Move it offline (a password manager) and delete this file. The server never needs it.",
    `PRIVY_ADMIN_QUORUM_ID=${quorumId}`,
    `PRIVY_ADMIN_PRIVATE_KEY=${privateKey}`,
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o600, flag: "wx" });
  return path;
}

export async function privyClient(env) {
  const appId = env.PRIVY_APP_ID || env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Set PRIVY_APP_ID (or NEXT_PUBLIC_PRIVY_APP_ID) and PRIVY_APP_SECRET in apps/business/.env.local.");
  const { PrivyClient } = await import("@privy-io/node");
  return new PrivyClient({ appId, appSecret });
}

export function banner(title) {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

/**
 * Name a secret without showing any of it: a short SHA-256 fingerprint, so two
 * runs can be told apart but no character of the key reaches a terminal or a log.
 */
export function mask(value) {
  return value ? `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 8)} (not shown)` : "(unset)";
}
