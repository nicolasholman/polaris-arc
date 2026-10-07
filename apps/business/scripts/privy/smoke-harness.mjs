#!/usr/bin/env node
// Run `privy:smoke -- --run` with everything it asks for, on Monad testnet:
// Polaris for Business (next dev) with RELAYER_MODE=privy on a fresh SQLite
// store, a merchant's sk_test_ key, and a throwaway buyer holding $1 of the
// mock dollar and no MON. The merchant is the one `smoke:testnet -- --run`
// registered and the Privy registry admin activated (docs/demo/testnet/results.json).
//
//   node apps/business/scripts/privy/smoke-harness.mjs            # checks the setup, sends nothing
//   node apps/business/scripts/privy/smoke-harness.mjs --run      # mints $1 to a fresh buyer, then privy:smoke -- --run
//
// Keys go to the child processes' environment only; nothing secret is printed.
// Refuses any chain but Monad testnet and any dollar but the labelled mock.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { mockAUSDAbi } from "@polarispay/contracts/abi";
import { APP_DIR, REPO_DIR, flag, loadEnv, parseEnvFile } from "./lib.mjs";
import { seedMerchant } from "../lib/seed.mjs";

const PORT = Number(process.env.PRIVY_SMOKE_PORT ?? 3963);
const BASE = `http://localhost:${PORT}`;
const RPC = process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz";
const record = JSON.parse(readFileSync(join(REPO_DIR, "packages", "contracts", "deployments", "monad-testnet.json"), "utf8"));
const results = JSON.parse(readFileSync(join(REPO_DIR, "docs", "demo", "testnet", "results.json"), "utf8"));
const merchant = getAddress(results.merchant.address);
const appEnv = loadEnv();
const rootEnv = { ...parseEnvFile(join(REPO_DIR, ".env")), ...process.env };

const problems = [];
if (Number(record.chainId) !== 10143) problems.push(`the record is for chain ${record.chainId}, not Monad testnet`);
if (record.contracts?.Stablecoin?.kind !== "MockAUSD") problems.push("the deployment's dollar is not the mock this harness can mint");
if (!rootEnv.DEPLOYER_PRIVATE_KEY) problems.push("DEPLOYER_PRIVATE_KEY is not set (repo-root .env): it mints the buyer's mock dollar");
for (const k of ["PRIVY_APP_SECRET", "PRIVY_RELAYER_WALLET_ID", "PRIVY_RELAYER_ADDRESS", "PRIVY_RELAYER_AUTH_KEY"]) if (!appEnv[k]) problems.push(`${k} is not set: run privy:setup-relayer -- --apply`);
if (appEnv.PRIVY_RELAYER_ADDRESS && getAddress(appEnv.PRIVY_RELAYER_ADDRESS) !== getAddress(record.roles?.relayer ?? "0x0000000000000000000000000000000000000000")) {
  problems.push(`the deployment's relayer is ${record.roles?.relayer}, not the Privy wallet ${appEnv.PRIVY_RELAYER_ADDRESS}: run grant-relayer:monad`);
}
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createPublicClient({ chain, transport: http(RPC) });
if ((await client.getChainId()) !== 10143) problems.push(`${RPC} is not Monad testnet`);
console.log(`privy:smoke harness on Monad testnet\n  merchant   ${merchant} (${results.merchant.name})\n  relayer    ${appEnv.PRIVY_RELAYER_ADDRESS ?? "(unset)"}`);
if (problems.length) {
  for (const p of problems) console.log(`  REFUSED    ${p}`);
  process.exit(1);
}
if (!flag("run")) {
  console.log("\nReady. Nothing was sent. Re-run with --run.");
  process.exit(0);
}
const free = await new Promise((resolve) => {
  const s = createServer();
  s.once("error", () => resolve(false));
  s.listen(PORT, "127.0.0.1", () => s.close(() => resolve(true)));
});
if (!free) throw new Error(`Port ${PORT} is in use.`);

const deployer = privateKeyToAccount(rootEnv.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? rootEnv.DEPLOYER_PRIVATE_KEY : `0x${rootEnv.DEPLOYER_PRIVATE_KEY}`);
const work = mkdtempSync(join(tmpdir(), "polaris-privy-smoke-"));
const dbUrl = `sqlite:${join(work, "polaris.db")}`;
const pepper = randomBytes(16).toString("hex");
const seeded = await seedMerchant({ dbUrl, pepper, wallet: merchant, name: results.merchant.name, registration: "active" });

const buyerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey);
const monBefore = await client.getBalance({ address: buyer.address });
const harness = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const mint = await harness.writeContract({ address: record.contracts.Stablecoin.address, abi: mockAUSDAbi, functionName: "mint", args: [buyer.address, 1_000_000n] });
await client.waitForTransactionReceipt({ hash: mint });
console.log(`  harness    minted $1.00 of MockAUSD to the throwaway buyer ${buyer.address} (${mint})`);

const serverEnv = {
  ...process.env,
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  POLARIS_DEPLOYMENT: "monad-testnet",
  POLARIS_RPC_URL: RPC,
  RELAYER_MODE: "privy",
  NEXT_PUBLIC_PRIVY_APP_ID: appEnv.NEXT_PUBLIC_PRIVY_APP_ID,
  PRIVY_APP_SECRET: appEnv.PRIVY_APP_SECRET,
  PRIVY_RELAYER_WALLET_ID: appEnv.PRIVY_RELAYER_WALLET_ID,
  PRIVY_RELAYER_ADDRESS: appEnv.PRIVY_RELAYER_ADDRESS,
  PRIVY_RELAYER_AUTH_KEY: appEnv.PRIVY_RELAYER_AUTH_KEY,
  REGISTRY_ACTIVATOR: "off",
  POLARIS_DB_URL: dbUrl,
  POLARIS_KEY_PEPPER: pepper,
  POLARIS_CHECKOUT_ORIGIN: `http://localhost:${PORT + 1}`,
  POLARIS_PUBLIC_URL: BASE,
  POLARIS_WORKERS: "1",
  RELAYER_RECEIPT_TIMEOUT_MS: "60000",
};
const next = spawn(process.execPath, [join(APP_DIR, "node_modules", "next", "dist", "bin", "next"), "dev", "--port", String(PORT)], {
  cwd: APP_DIR,
  env: serverEnv,
  stdio: ["ignore", "ignore", "ignore"],
});
const stop = () =>
  process.platform === "win32" ? spawn("taskkill", ["/pid", String(next.pid), "/T", "/F"], { stdio: "ignore" }) : next.kill("SIGTERM");
try {
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok && (await r.json()).data?.ok) break;
    } catch {
      // not yet
    }
    if (Date.now() - started > 600_000) throw new Error("the server didn't start");
    await new Promise((r) => setTimeout(r, 2000));
  }
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(APP_DIR, "scripts", "privy", "smoke-monad.mjs"), "--run"], {
      cwd: APP_DIR,
      env: { ...process.env, POLARIS_API: BASE, POLARIS_SECRET_KEY: seeded.secretKey, BUYER_PRIVATE_KEY: buyerKey },
      stdio: "inherit",
    });
    child.on("exit", resolve);
  });
  const monAfter = await client.getBalance({ address: buyer.address });
  const nonce = await client.getTransactionCount({ address: buyer.address });
  console.log(`  buyer      ${buyer.address}: ${formatEther(monBefore)} MON before, ${formatEther(monAfter)} MON after, nonce ${nonce}`);
  if (monAfter !== 0n || nonce !== 0) {
    console.log("  FAIL       the buyer held MON or sent a transaction");
    process.exitCode = 1;
  } else {
    process.exitCode = code;
  }
} finally {
  stop();
  setTimeout(() => {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // Windows may still hold the database for a moment
    }
    process.exit(process.exitCode ?? 0);
  }, 1500);
}
