#!/usr/bin/env node
// Polaris on the live Monad testnet deployment, gasless end to end through the
// relayer, with fresh throwaway accounts that never hold MON:
//
//   pnpm --filter @polaris/business smoke:testnet               # checks the setup, sends nothing
//   pnpm --filter @polaris/business smoke:testnet -- --run      # every buyer and merchant action, relayed
//
// Options:
//   --relayer privy   (the default when PRIVY_RELAYER_WALLET_ID is set) the Privy
//                     server wallet from `privy:setup-relayer`, under its policy;
//   --relayer local   the dev adapter's raw testnet key (TESTNET_RELAYER_PRIVATE_KEY),
//                     the stand-in used before the Privy relayer existed;
//   --interval <s>    seconds between Pay in 4 instalments (60: the deployment's
//                     minimum, so the CRE collections workflow has something due).
//
//  1. reads packages/contracts/deployments/monad-testnet.json (refuses any
//     chain but Monad testnet, 10143, and any dollar but the labelled mock it
//     can mint), DEPLOYER_PRIVATE_KEY from the git-ignored repo-root .env
//     (the test harness: it mints mock dollars and plays "a lost approval"),
//     and the relayer's settings from apps/business/.env.local and .env.privy
//     (git-ignored). No key is ever printed;
//  2. starts Polaris for Business (next dev) on SMOKE_PORT (3960) with that
//     relayer, a fresh SQLite store and a webhook receiver on SMOKE_HOOK_PORT
//     (3961) that verifies every delivery with polarispay-sdk;
//  3. makes five fresh accounts, none of which is ever sent MON: a merchant,
//     its payout address, a buyer, a send-by-link key and the link's
//     recipient. Then, every step a signature the relayer carries:
//     - the merchant registers on MerchantRegistry (its Registration
//       signature, `registerFor` sent by the relayer: the call the dashboard's
//       registration makes; the dashboard route itself needs a Privy login);
//     - Pay now; the registry admin (a Privy wallet too, when
//       REGISTRY_ACTIVATOR=privy) then activates the merchant for Pay in 4;
//     - a secured line: the buyer's permit to CollateralVault, relayed as
//       `lockWithPermit` (an unsecured line needs a CRE underwriting report,
//       which a throwaway account can't get: requireUnderwriting is on);
//     - Pay in 4, a subscription, paying an instalment early, a lost approval
//       signed again (reauthorize), a send by link and its claim, cancelling
//       the subscription, and the merchant's one-tap withdraw (its
//       TransferWithAuthorization, the call the dashboard's Withdraw relays);
//  4. reads every transaction back (status, sender, target), checks the
//     webhooks, and checks that none of the five accounts sent a transaction
//     or holds any MON, before and after. Writes docs/demo/testnet/results.json
//     and docs/demo/testnet/README.md.
//
// The harness's own transactions (the deployer minting mock dollars, and
// submitting the buyer's signed permit(0) to play a lost approval) are
// labelled as such; they are test setup, not something a user does.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  parseSignature,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  collateralVaultAbi,
  merchantRegistryAbi,
  mockAUSDAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSendAbi,
  scoreManagerAbi,
} from "@polarispay/contracts/abi";
import { APP_DIR, REPO_DIR, flag, loadEnv, option, parseEnvFile } from "./privy/lib.mjs";
import { seedMerchant } from "./lib/seed.mjs";
import { polarisDomain, TYPES } from "../src/server/relayer/typed-data.ts";

const PORT = Number(process.env.SMOKE_PORT ?? 3960);
const HOOK_PORT = Number(process.env.SMOKE_HOOK_PORT ?? 3961);
const BASE = `http://localhost:${PORT}`;
const RECORD = join(REPO_DIR, "packages", "contracts", "deployments", "monad-testnet.json");
const OUT_DIR = join(REPO_DIR, "docs", "demo", "testnet");
const SDK_DIR = join(REPO_DIR, "packages", "sdk");
const RPC = process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz";
const INTERVAL = Number(option("interval", "60"));
const PLAN_USD = 200;
const PAY_NOW_USD = 25;
const SUBSCRIBE_USD = 5;
const SEND_USD = 10;
const WITHDRAW_USD = 100;
const MINT_UNITS = 1_000_000_000n; // $1,000.00 of the mock dollar

const children = [];
let work = null; // the server's SQLite store, made when the run starts
const steps = [];
let n = 0;

const log = (m) => console.log(m);
function pass(what, detail = "") {
  log(`  ${String(++n).padStart(2)}. PASS  ${what}${detail ? `  ${detail}` : ""}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}
const usd = (units) => `$${formatUnits(units, 6)}`;

async function until(what, fn, { timeoutMs = 60_000, everyMs = 1000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function background(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const lines = [];
  const keep = (b) => {
    for (const line of b.toString().split(/\r?\n/)) if (line.trim()) lines.push(line);
    if (lines.length > 300) lines.splice(0, lines.length - 300);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  children.push({ name, child, lines });
  return child;
}

async function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function relay(body) {
  const res = await api("/api/relay", { method: "POST", body: JSON.stringify(body) });
  assert(res.status === 200 && res.body?.data?.txHash, `relay ${body.type}: ${res.status} ${JSON.stringify(res.body?.error ?? res.body)}`);
  return res.body.data;
}

/** The keys this run needs, from the environment or the git-ignored repo-root .env. Never printed. */
export function keysFrom(env) {
  const hex = (name) => {
    const v = env[name]?.trim();
    if (!v) return null;
    const k = v.startsWith("0x") ? v : `0x${v}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex key`);
    return k;
  };
  return { deployer: hex("DEPLOYER_PRIVATE_KEY"), relayer: hex("TESTNET_RELAYER_PRIVATE_KEY") };
}

/** Which relayer to run with: --relayer, else privy when the Privy relayer is configured, else local. */
export function relayerModeFrom(argv, env) {
  const i = argv.indexOf("--relayer");
  const asked = i !== -1 ? argv[i + 1] : null;
  if (asked && asked !== "privy" && asked !== "local") throw new Error(`--relayer must be privy or local, not ${asked}`);
  return asked ?? (env.PRIVY_RELAYER_WALLET_ID ? "privy" : "local");
}

/** The Privy relayer's settings (apps/business/.env.local and .env.privy), or the reasons it can't run. */
export function privyRelayerFrom(env) {
  const problems = [];
  const appId = env.PRIVY_APP_ID || env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId || !env.PRIVY_APP_SECRET) problems.push("NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET are not set (apps/business/.env.local).");
  if (!env.PRIVY_RELAYER_WALLET_ID || !env.PRIVY_RELAYER_AUTH_KEY) problems.push("PRIVY_RELAYER_WALLET_ID and PRIVY_RELAYER_AUTH_KEY are not set: run privy:setup-relayer -- --apply first.");
  let address = null;
  try {
    address = env.PRIVY_RELAYER_ADDRESS ? getAddress(env.PRIVY_RELAYER_ADDRESS) : null;
  } catch {
    problems.push("PRIVY_RELAYER_ADDRESS is not an address.");
  }
  if (!address && problems.length === 0) problems.push("PRIVY_RELAYER_ADDRESS is not set.");
  return { appId, address, problems };
}

/** Everything that must hold before a transaction is sent: the reasons to refuse (empty when ready). */
export function preflight({ record, keys, mode = "local", relayerAddress, relayerBalance, deployerBalance, minRelayer, minDeployer, privyProblems = [] }) {
  const problems = [];
  if (!record) return ["No packages/contracts/deployments/monad-testnet.json: run deploy:monad first."];
  if (Number(record.chainId) !== 10143) problems.push(`The record is for chain ${record.chainId}: this script only ever writes to Monad testnet (10143).`);
  if (record.contracts?.Stablecoin?.kind !== "MockAUSD") problems.push("The deployment's dollar is not the mock: this script mints test dollars and would need real AUSD instead.");
  if (!keys.deployer) problems.push("DEPLOYER_PRIVATE_KEY is not set (repo-root .env): it mints the mock dollars and plays the lost approval.");
  if (mode === "local" && !keys.relayer) problems.push("TESTNET_RELAYER_PRIVATE_KEY is not set (repo-root .env): the dev relayer's key.");
  if (mode === "privy") problems.push(...privyProblems);
  if (relayerAddress && record.roles?.relayer && getAddress(record.roles.relayer) !== getAddress(relayerAddress)) {
    problems.push(`The ${mode} relayer is ${relayerAddress}, but the deployment gave operator roles to ${record.roles.relayer}.`);
  }
  if (relayerBalance !== undefined && relayerBalance < minRelayer) problems.push(`The relayer holds ${formatEther(relayerBalance)} MON; it needs about ${formatEther(minRelayer)}.`);
  if (deployerBalance !== undefined && deployerBalance < minDeployer) problems.push(`The deployer holds ${formatEther(deployerBalance)} MON; it needs about ${formatEther(minDeployer)}.`);
  return problems;
}

/** The markdown table of a run, as README.md shows it. */
export function markdownFrom(result) {
  const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
  const lines = [
    "# Gasless on Monad testnet: the live run",
    "",
    `Written by \`pnpm --filter @polaris/business smoke:testnet -- --run\` on ${result.at}. Every row is a real Monad testnet (chain 10143) transaction, read back from the chain: status 1, sent to the contract named, and sent by the account in "Sent by". The dollar is \`MockAUSD\`, a labelled mock (decision 24).`,
    "",
    `**Relayer:** ${result.relayer.mode === "privy" ? "the Privy server wallet" : "the dev adapter's key"} \`${result.relayer.address}\`${result.relayer.walletId ? ` (Privy wallet \`${result.relayer.walletId}\`, policy \`${result.relayer.policyId ?? "?"}\`)` : ""}. It sent ${result.relayer.transactions} transactions and spent ${result.relayer.monSpent} MON.`,
    ...(result.activator ? [`**Registry admin:** the Privy server wallet \`${result.activator.address}\`, which owns MerchantRegistry and may only activate and cap merchants. It spent ${result.activator.monSpent} MON.`] : []),
    "",
    "| # | Step | Signed by | Sent by | Contract | Transaction | Block |",
    "|---|---|---|---|---|---|---:|",
    ...result.steps.map((s, i) => `| ${i + 1} | ${s.what} | ${s.signedBy} | ${s.by} | ${s.contract} | [\`${short(s.txHash)}\`](${s.explorer}) | ${s.block} |`),
    "",
    "## The users paid nothing",
    "",
    "Every account below was generated for this run. None was ever sent MON, and none sent a transaction: its MON balance and its nonce are read from the chain before the first step and after the last.",
    "",
    "| Account | Role | MON before | MON after | Nonce before | Nonce after |",
    "|---|---|---:|---:|---:|---:|",
    ...result.users.map((u) => `| \`${u.address}\` | ${u.role} | ${u.monBefore} | ${u.monAfter} | ${u.nonceBefore} | ${u.nonceAfter} |`),
    "",
    "## Webhooks",
    "",
    ...result.webhooks.map((w) => `- \`${w.type}\` (${w.id}), verified with polarispay-sdk`),
    "",
    "Every hash, id and address: [`results.json`](results.json).",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  log("Polaris on Monad testnet: gasless, end to end\n");
  const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : null;
  const rootEnv = { ...parseEnvFile(join(REPO_DIR, ".env")), ...process.env };
  const appEnv = loadEnv();
  const keys = keysFrom(rootEnv);
  const mode = relayerModeFrom(process.argv, appEnv);
  const privyRelayer = mode === "privy" ? privyRelayerFrom(appEnv) : null;
  const chain = defineChain({
    id: 10143,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 500 });
  const localRelayer = mode === "local" && keys.relayer ? privateKeyToAccount(keys.relayer) : null;
  const relayerAddress = mode === "privy" ? privyRelayer.address : localRelayer?.address;
  const deployer = keys.deployer ? privateKeyToAccount(keys.deployer) : null;
  const problems = preflight({
    record,
    keys,
    mode,
    relayerAddress,
    relayerBalance: relayerAddress ? await client.getBalance({ address: relayerAddress }) : undefined,
    deployerBalance: deployer ? await client.getBalance({ address: deployer.address }) : undefined,
    minRelayer: 150_000_000_000_000_000n,
    minDeployer: 30_000_000_000_000_000n,
    privyProblems: privyRelayer?.problems ?? [],
  });
  if ((await client.getChainId()) !== 10143) problems.push(`${RPC} is not Monad testnet.`);
  const activatorMode = (appEnv.REGISTRY_ACTIVATOR ?? "off").toLowerCase();
  const registryOwner = record ? await client.readContract({ address: record.contracts.MerchantRegistry.address, abi: merchantRegistryAbi, functionName: "owner" }) : null;
  const activatorAddress = activatorMode === "privy" && appEnv.PRIVY_REGISTRY_ADDRESS ? getAddress(appEnv.PRIVY_REGISTRY_ADDRESS) : null;
  if (activatorMode === "privy") {
    if (!activatorAddress || !appEnv.PRIVY_REGISTRY_WALLET_ID || !appEnv.PRIVY_REGISTRY_AUTH_KEY) problems.push("REGISTRY_ACTIVATOR=privy needs PRIVY_REGISTRY_WALLET_ID, _ADDRESS and _AUTH_KEY.");
    else if (getAddress(registryOwner) !== activatorAddress) problems.push(`MerchantRegistry is owned by ${registryOwner}, not the registry admin ${activatorAddress}: run transfer-registry-owner.mjs --apply.`);
  } else if (mode === "privy") {
    problems.push("REGISTRY_ACTIVATOR is not privy: this run activates its merchant through the Privy registry admin.");
  }
  log(`  deployment  ${RECORD.replace(REPO_DIR, "").replace(/\\/g, "/")}`);
  if (relayerAddress) log(`  relayer     ${relayerAddress} (${mode === "privy" ? `Privy server wallet ${appEnv.PRIVY_RELAYER_WALLET_ID}` : "dev adapter, RELAYER_MODE=local"})`);
  if (activatorAddress) log(`  activator   ${activatorAddress} (Privy registry admin; owns MerchantRegistry)`);
  if (deployer) log(`  harness     ${deployer.address} (mints the mock dollar; plays the lost approval)`);
  if (problems.length) {
    for (const p of problems) log(`  REFUSED     ${p}`);
    process.exitCode = 1;
    return;
  }
  if (!flag("run")) {
    log("\nReady. Nothing was sent. Re-run with --run for every buyer and merchant action on Monad testnet.");
    return;
  }
  if (!Number.isInteger(INTERVAL) || INTERVAL < Number(record.config?.minInterval ?? 60)) throw new Error(`--interval must be at least ${record.config?.minInterval ?? 60} seconds`);
  for (const p of [PORT, HOOK_PORT]) if (!(await portFree(p))) throw new Error(`Port ${p} is in use.`);

  const C = Object.fromEntries(Object.entries(record.contracts).map(([k, v]) => [k, getAddress(v.address)]));
  const names = Object.fromEntries(Object.entries(C).map(([k, v]) => [v.toLowerCase(), k]));
  const explorer = (record.explorer ?? "https://testnet.monadscan.com").replace(/\/+$/, "");
  const harness = createWalletClient({ account: deployer, chain, transport: http(RPC) });
  const relayerNonce0 = await client.getTransactionCount({ address: relayerAddress });
  const relayerMon0 = await client.getBalance({ address: relayerAddress });
  const activatorMon0 = activatorAddress ? await client.getBalance({ address: activatorAddress }) : null;
  const byOf = (from) => {
    const f = getAddress(from);
    if (f === getAddress(relayerAddress)) return mode === "privy" ? "Privy relayer" : "dev relayer";
    if (activatorAddress && f === activatorAddress) return "Privy registry admin";
    if (f === deployer.address) return "harness (deployer)";
    return f;
  };

  /** One transaction, read back: who sent it, to what, whether it landed, and its events. */
  async function onChain(what, hash, { from, to, signedBy, abi }) {
    // The receipt first: a public RPC may not serve a transaction it has only just accepted.
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    const tx = await until(`transaction ${hash}`, () => client.getTransaction({ hash }), { timeoutMs: 30_000 });
    assert(receipt.status === "success", `${what}: ${hash} reverted`);
    if (from) assert(getAddress(tx.from) === getAddress(from), `${what}: sent by ${tx.from}, expected ${from}`);
    if (to) assert(getAddress(tx.to) === getAddress(to), `${what}: sent to ${tx.to}, expected ${to}`);
    const events = abi ? parseEventLogs({ abi, logs: receipt.logs }).map((e) => e.eventName) : [];
    const row = {
      what,
      signedBy,
      by: byOf(tx.from),
      from: getAddress(tx.from),
      to: getAddress(tx.to),
      contract: names[getAddress(tx.to).toLowerCase()] ?? getAddress(tx.to),
      txHash: hash,
      block: Number(receipt.blockNumber),
      status: receipt.status === "success" ? 1 : 0,
      gasLimit: tx.gas.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
      value: tx.value.toString(),
      events,
      explorer: `${explorer}/tx/${hash}`,
    };
    assert(tx.value === 0n, `${what}: carried ${tx.value} wei of MON`);
    steps.push(row);
    return { tx, receipt, row };
  }

  // ── the SDK, built ─────────────────────────────────────────────────────
  if (!existsSync(join(SDK_DIR, "dist", "esm", "server.js"))) throw new Error("polarispay-sdk is not built: pnpm --filter polarispay-sdk build");
  const sdkServer = await import(new URL(`file:///${join(SDK_DIR, "dist", "esm", "server.js").replace(/\\/g, "/")}`).href);

  // ── the webhook receiver ───────────────────────────────────────────────
  const received = [];
  let webhookSecret = null;
  const hooks = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        received.push({ event: sdkServer.verifyWebhook(raw, req.headers["polaris-signature"], webhookSecret) });
        res.writeHead(204).end();
      } catch (error) {
        received.push({ error: error.message });
        res.writeHead(400).end("bad signature");
      }
    });
  });
  await new Promise((r) => hooks.listen(HOOK_PORT, "127.0.0.1", r));

  // ── the accounts: fresh, and never sent MON ────────────────────────────
  const merchant = privateKeyToAccount(generatePrivateKey());
  const payout = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const linkKey = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey());
  const users = [
    { role: "merchant (registers, is paid, withdraws)", account: merchant },
    { role: "the merchant's payout address", account: payout },
    { role: "buyer (Pay now, collateral, Pay in 4, subscribe, pay early, re-sign, send, cancel)", account: buyer },
    { role: "send-by-link key (opens and claims the link)", account: linkKey },
    { role: "the link's recipient", account: recipient },
  ];
  for (const u of users) {
    u.monBefore = await client.getBalance({ address: u.account.address });
    u.nonceBefore = await client.getTransactionCount({ address: u.account.address });
    assert(u.monBefore === 0n && u.nonceBefore === 0, `${u.role} ${u.account.address} starts with no MON and no transactions`);
  }
  pass("five fresh accounts, none holding MON or having sent anything", users.map((u) => u.account.address.slice(0, 8)).join(" "));

  // ── the server ─────────────────────────────────────────────────────────
  work = mkdtempSync(join(tmpdir(), "polaris-smoke-"));
  const dbUrl = `sqlite:${join(work, "polaris.db")}`;
  const pepper = randomBytes(16).toString("hex");
  const relayerEnv =
    mode === "privy"
      ? {
          RELAYER_MODE: "privy",
          NEXT_PUBLIC_PRIVY_APP_ID: privyRelayer.appId,
          PRIVY_APP_SECRET: appEnv.PRIVY_APP_SECRET,
          PRIVY_RELAYER_WALLET_ID: appEnv.PRIVY_RELAYER_WALLET_ID,
          PRIVY_RELAYER_ADDRESS: relayerAddress,
          PRIVY_RELAYER_AUTH_KEY: appEnv.PRIVY_RELAYER_AUTH_KEY,
        }
      : { RELAYER_MODE: "local", RELAYER_LOCAL_ALLOW_TESTNET: "1", RELAYER_PRIVATE_KEY: keys.relayer, POLARIS_DISABLE_PRIVY: "1" };
  const activatorEnv =
    activatorMode === "privy"
      ? {
          REGISTRY_ACTIVATOR: "privy",
          PRIVY_REGISTRY_WALLET_ID: appEnv.PRIVY_REGISTRY_WALLET_ID,
          PRIVY_REGISTRY_ADDRESS: activatorAddress,
          PRIVY_REGISTRY_AUTH_KEY: appEnv.PRIVY_REGISTRY_AUTH_KEY,
        }
      : { REGISTRY_ACTIVATOR: "off" };
  const serverEnv = {
    ...process.env,
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    POLARIS_DEPLOYMENT_FILE: RECORD,
    POLARIS_RPC_URL: RPC,
    ...relayerEnv,
    ...activatorEnv,
    MERCHANT_ACTIVATION_MIN_PAYMENTS: "1",
    POLARIS_DB_URL: dbUrl,
    POLARIS_KEY_PEPPER: pepper,
    POLARIS_WEBHOOK_ALLOW_PRIVATE: "1",
    POLARIS_CHECKOUT_ORIGIN: "http://localhost:3962",
    POLARIS_PUBLIC_URL: BASE,
    POLARIS_WORKERS: "1",
    PAY_IN_4_INTERVAL_SECONDS: String(INTERVAL),
    CRON_SECRET: randomBytes(16).toString("hex"),
    RELAYER_RECEIPT_TIMEOUT_MS: "60000",
  };
  // The server imports @polarispay/underwriting's compiled core: build it if it is missing or stale.
  const deps = background("ensure-deps", process.execPath, [join(APP_DIR, "scripts", "ensure-deps.mjs")], { cwd: APP_DIR });
  const depsCode = await new Promise((resolve) => deps.on("exit", resolve));
  if (depsCode !== 0) throw new Error(`scripts/ensure-deps.mjs exited ${depsCode}`);
  const next = join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
  background("next", process.execPath, [next, "dev", "--port", String(PORT)], { cwd: APP_DIR, env: serverEnv });
  const health = await until(
    "Polaris for Business",
    async () => {
      const h = await api("/api/health");
      return h.status === 200 && h.body?.data?.ok ? h.body.data : null;
    },
    { timeoutMs: 600_000, everyMs: 2000 },
  );
  assert(health.chain.id === 10143, "the server is on Monad testnet");
  assert(health.relayer.mode === mode, `the server relays with the ${mode} relayer (it says ${health.relayer.mode})`);
  assert(getAddress(health.relayer.address) === getAddress(relayerAddress), "the server relays from the configured relayer address");
  pass(`Polaris for Business is up on Monad testnet with the ${mode} relayer`, `(${health.relayer.address})`);

  // ── the merchant registers: its signature, the relayer's registerFor ───
  const seeded = await seedMerchant({ dbUrl, pepper, wallet: merchant.address, name: `Smoke Studio ${Date.now().toString(36)}`, webhookUrl: `http://127.0.0.1:${HOOK_PORT}/webhook`, registration: "registered" });
  webhookSecret = seeded.webhookSecret;
  const regNonce = await client.readContract({ address: C.MerchantRegistry, abi: merchantRegistryAbi, functionName: "nonces", args: [merchant.address] });
  const regDeadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const registration = {
    merchant: merchant.address,
    name: seeded.merchant.businessName,
    payoutAddress: merchant.address,
    metadataURI: `${BASE}/api/public/merchants/${seeded.merchant.publicId}`,
    nonce: regNonce,
    deadline: regDeadline,
  };
  const regSig = await merchant.signTypedData({ domain: polarisDomain("registry", 10143, C.MerchantRegistry), types: TYPES.Registration, primaryType: "Registration", message: registration });
  const registerData = encodeFunctionData({
    abi: merchantRegistryAbi,
    functionName: "registerFor",
    args: [merchant.address, registration.name, registration.payoutAddress, registration.metadataURI, regDeadline, regSig],
  });
  const regHash = await sendAsRelayer({ mode, client, chain, to: C.MerchantRegistry, data: registerData, relayerAddress, localKey: keys.relayer, appEnv });
  await onChain("The merchant registers on MerchantRegistry: its Registration signature, registerFor sent by the relayer", regHash, { from: relayerAddress, to: C.MerchantRegistry, signedBy: "merchant", abi: merchantRegistryAbi });
  const registered = await client.readContract({ address: C.MerchantRegistry, abi: merchantRegistryAbi, functionName: "merchantOf", args: [merchant.address] });
  assert(registered.registeredAt > 0n && !registered.active, "the merchant is registered, not yet active");
  pass("merchant registered on chain, gas paid by the relayer", `(${regHash})`);
  const polaris = sdkServer.createPolarisServer({ secretKey: seeded.secretKey, baseUrl: BASE });
  const waitFor = (type, match) => until(`the ${type} webhook`, () => received.find((r) => r.event?.type === type && match(r.event)), { timeoutMs: 180_000 });

  // ── the harness gives the buyer mock dollars (anyone may mint them) ────
  const mint = await harness.writeContract({ address: C.Stablecoin, abi: mockAUSDAbi, functionName: "mint", args: [buyer.address, MINT_UNITS] });
  await onChain(`Harness: mint ${usd(MINT_UNITS)} of MockAUSD (the labelled mock dollar) to the buyer`, mint, { from: deployer.address, to: C.Stablecoin, signedBy: "harness", abi: mockAUSDAbi });

  const tokenDomain = { name: "Agora Dollar", version: "1", chainId: 10143, verifyingContract: C.Stablecoin };
  const permit = async (spender, value, deadlineSeconds = 1800) => {
    const nonce = await client.readContract({ address: C.Stablecoin, abi: mockAUSDAbi, functionName: "nonces", args: [buyer.address] });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
    const signature = await buyer.signTypedData({ domain: tokenDomain, types: TYPES.Permit, primaryType: "Permit", message: { owner: buyer.address, spender, value, nonce, deadline } });
    return { value, deadline, signature, body: { value: String(value), deadline: String(deadline), signature } };
  };

  // ── Pay now ────────────────────────────────────────────────────────────
  const orderNow = `smoke-now-${Date.now()}`;
  const s1 = await polaris.checkout.sessions.create(
    { amount: `${PAY_NOW_USD}.00`, description: "Gasless smoke: Pay now", modes: ["now"], successUrl: "http://localhost:3962/thanks", orderId: orderNow },
    { idempotencyKey: orderNow },
  );
  const pub1 = (await api(`/api/public/sessions/${s1.id}`)).body.data;
  assert(getAddress(pub1.chain.contracts.stablecoin) === C.Stablecoin, "the session signs for the deployment's dollar");
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 900);
  const rwa = await buyer.signTypedData({
    domain: tokenDomain,
    types: TYPES.ReceiveWithAuthorization,
    primaryType: "ReceiveWithAuthorization",
    message: { from: buyer.address, to: C.PolarisPayments, value: BigInt(PAY_NOW_USD) * 1_000_000n, validAfter: 0n, validBefore, nonce: pub1.chain.orderKey },
  });
  const paid = await relay({ type: "pay", sessionId: s1.id, buyer: buyer.address, validAfter: "0", validBefore: String(validBefore), signature: rwa });
  await onChain(`Pay now ${usd(BigInt(PAY_NOW_USD) * 1_000_000n)}: PolarisCheckout.pay`, paid.txHash, { from: relayerAddress, to: C.PolarisCheckout, signedBy: "buyer (ReceiveWithAuthorization)", abi: polarisCheckoutAbi });
  const payEvent = await waitFor("payment.succeeded", (e) => e.data.sessionId === s1.id);
  pass("Pay now relayed and settled; payment.succeeded arrived, verified by polarispay-sdk", `(${paid.txHash})`);

  // ── the registry admin activates the merchant after its first sale ─────
  let activation = null;
  if (activatorMode === "privy") {
    const active = await until(
      "the merchant's activation",
      async () => {
        const m = await client.readContract({ address: C.MerchantRegistry, abi: merchantRegistryAbi, functionName: "merchantOf", args: [merchant.address] });
        return m.active ? m : null;
      },
      { timeoutMs: 180_000, everyMs: 2000 },
    );
    activation = await relaysOfKind(dbUrl, "activateMerchant");
    assert(activation.length === 2, `two activation calls (cap, activate), found ${activation.length}`);
    for (const a of activation) {
      await onChain(
        a.id.startsWith("activate:") ? "The registry admin activates the merchant for Pay in 4: MerchantRegistry.setActive" : "The registry admin caps the merchant: MerchantRegistry.setMaxOrderValue",
        a.txHash,
        { from: activatorAddress, to: C.MerchantRegistry, signedBy: "none (the registry admin's own call, under its Privy policy)", abi: merchantRegistryAbi },
      );
    }
    pass("the Privy registry admin activated the merchant after its first sale", `(cap ${usd(active.maxOrderValue)})`);
  }

  // ── a secured line: the buyer's permit to the vault, relayed ───────────
  const quoteFor = () => client.readContract({ address: C.PolarisCheckout, abi: polarisCheckoutAbi, functionName: "quotePlan", args: [buyer.address, BigInt(PLAN_USD) * 1_000_000n, 4, BigInt(INTERVAL)] });
  const q0 = await quoteFor();
  const collateral = ((q0.totalOwed + 999_999n) / 1_000_000n + 1n) * 1_000_000n; // whole dollars, above everything owed
  const vaultPermit = await permit(C.CollateralVault, collateral);
  const locked = await relay({ type: "lockCollateral", borrower: buyer.address, amount: String(collateral), permit: vaultPermit.body });
  await onChain(`A secured line: the buyer sets ${usd(collateral)} aside, CollateralVault.lockWithPermit`, locked.txHash, { from: relayerAddress, to: C.CollateralVault, signedBy: "buyer (Permit to the vault)", abi: collateralVaultAbi });
  const limit = await client.readContract({ address: C.ScoreManager, abi: scoreManagerAbi, functionName: "creditLimitOf", args: [buyer.address] });
  assert(limit === collateral, `a never-underwritten wallet borrows against collateral at face value (limit ${limit})`);
  pass("secured credit line from collateral locked by a relayed permit (no CRE underwriting report for a throwaway account)", `(limit ${usd(limit)})`);

  // ── Pay in 4 ───────────────────────────────────────────────────────────
  const orderPlan = `smoke-plan-${Date.now()}`;
  const s2 = await polaris.checkout.sessions.create(
    { amount: `${PLAN_USD}.00`, description: "Gasless smoke: Pay in 4", modes: ["later"], successUrl: "http://localhost:3962/thanks", orderId: orderPlan },
    { idempotencyKey: orderPlan },
  );
  const pub2 = (await api(`/api/public/sessions/${s2.id}?buyer=${buyer.address}`)).body.data;
  assert(pub2.payIn4?.available, `Pay in 4 offered: ${JSON.stringify(pub2.payIn4)}`);
  const quote = await quoteFor();
  assert(quote.withinLimit, "the plan fits the secured line");
  const checkoutNonce = await client.readContract({ address: C.PolarisCheckout, abi: polarisCheckoutAbi, functionName: "nonces", args: [buyer.address] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const intent = { buyer: buyer.address, merchant: merchant.address, principal: BigInt(PLAN_USD) * 1_000_000n, installments: 4, interval: BigInt(INTERVAL), orderId: pub2.chain.orderId, nonce: checkoutNonce, deadline: now + 600n };
  const intentSig = await buyer.signTypedData({ domain: polarisDomain("checkout", 10143, C.PolarisCheckout), types: TYPES.PlanIntent, primaryType: "PlanIntent", message: intent });
  const planPermit = await permit(C.PolarisLoanEngine, quote.permitValue);
  const opened = await relay({
    type: "openPlan",
    sessionId: s2.id,
    intent: { buyer: buyer.address, principal: String(intent.principal), installments: "4", interval: String(INTERVAL), nonce: String(checkoutNonce), deadline: String(intent.deadline) },
    signature: intentSig,
    permit: planPermit.body,
  });
  assert(opened.planId, `openPlan returned a plan id: ${JSON.stringify(opened)}`);
  const planTx = await onChain(`Pay in 4 ${usd(intent.principal)} (4 instalments, ${INTERVAL} s apart): PolarisCheckout.openPlan`, opened.txHash, { from: relayerAddress, to: C.PolarisCheckout, signedBy: "buyer (PlanIntent + Permit)", abi: polarisLoanEngineAbi });
  planTx.row.planId = opened.planId;
  const planEvent = await waitFor("plan.opened", (e) => e.data.sessionId === s2.id);
  assert(planEvent.event.data.schedule.length === 4, "plan.opened carries the schedule");
  pass("Pay in 4 opened, merchant paid in full; plan.opened arrived with the schedule", `(plan #${opened.planId})`);

  // ── Subscribe ──────────────────────────────────────────────────────────
  const orderSub = `smoke-sub-${Date.now()}`;
  const s3 = await polaris.checkout.sessions.create(
    { amount: `${SUBSCRIBE_USD}.00`, description: "Gasless smoke: Subscribe", modes: ["subscribe"], subscription: { interval: "month" }, successUrl: "http://localhost:3962/thanks", orderId: orderSub },
    { idempotencyKey: orderSub },
  );
  const pub3 = await until(
    "the subscription plan on chain",
    async () => {
      const r = await api(`/api/public/sessions/${s3.id}?buyer=${buyer.address}`);
      return r.body?.data?.subscription?.planId ? r.body.data : null;
    },
    { timeoutMs: 120_000, everyMs: 2000 },
  );
  const subPlan = (await relaysOfKind(dbUrl, "createSubscriptionPlan"))[0];
  if (subPlan) await onChain("The merchant's subscription plan: PolarisPayments.createPlanFor (operator)", subPlan.txHash, { from: relayerAddress, to: C.PolarisPayments, signedBy: "none (operator: the session's terms)", abi: polarisPaymentsAbi });
  const subNonce = await client.readContract({ address: C.PolarisCheckout, abi: polarisCheckoutAbi, functionName: "nonces", args: [buyer.address] });
  const subIntent = {
    buyer: buyer.address,
    merchant: merchant.address,
    planId: BigInt(pub3.subscription.planId),
    pricePerPeriod: BigInt(pub3.subscription.pricePerPeriodUnits),
    periodSeconds: BigInt(pub3.subscription.periodSeconds),
    orderId: pub3.chain.orderId,
    nonce: subNonce,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const subSig = await buyer.signTypedData({ domain: polarisDomain("checkout", 10143, C.PolarisCheckout), types: TYPES.SubscribeIntent, primaryType: "SubscribeIntent", message: subIntent });
  const subPermit = await permit(C.PolarisPayments, BigInt(pub3.buyer.subscription.permitValue));
  const subscribed = await relay({
    type: "subscribe",
    sessionId: s3.id,
    intent: {
      buyer: buyer.address,
      planId: String(subIntent.planId),
      pricePerPeriod: String(subIntent.pricePerPeriod),
      periodSeconds: String(subIntent.periodSeconds),
      nonce: String(subNonce),
      deadline: String(subIntent.deadline),
    },
    signature: subSig,
    permit: subPermit.body,
  });
  const subTx = await onChain(`Subscribe ${usd(subIntent.pricePerPeriod)} a month, first month charged: PolarisCheckout.subscribe`, subscribed.txHash, { from: relayerAddress, to: C.PolarisCheckout, signedBy: "buyer (SubscribeIntent + Permit)", abi: polarisPaymentsAbi });
  const [started] = parseEventLogs({ abi: polarisPaymentsAbi, logs: subTx.receipt.logs, eventName: "Subscribed" });
  const subId = subscribed.subscriptionId ?? started?.args?.subId?.toString();
  assert(subId, "the subscription has an id");
  subTx.row.subscriptionId = String(subId);
  const subEvent = await waitFor("subscription.charged", (e) => String(e.data.subscriptionId) === String(subId)).catch(() => null);
  pass("subscribed, first period charged", `(subscription #${subId}${subEvent ? `, ${subEvent.event.type} webhook` : ""})`);

  // ── Pay an instalment early ────────────────────────────────────────────
  const loan = await client.readContract({ address: C.PolarisLoanEngine, abi: polarisLoanEngineAbi, functionName: "getLoan", args: [BigInt(opened.planId)] });
  const engineNonce = await client.readContract({ address: C.PolarisLoanEngine, abi: polarisLoanEngineAbi, functionName: "nonces", args: [buyer.address] });
  const repayAmount = await client.readContract({ address: C.PolarisLoanEngine, abi: polarisLoanEngineAbi, functionName: "installmentAmount", args: [BigInt(opened.planId)] });
  const repayDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const repaySig = await buyer.signTypedData({
    domain: polarisDomain("loanEngine", 10143, C.PolarisLoanEngine),
    types: TYPES.RepayIntent,
    primaryType: "RepayIntent",
    message: { loanId: BigInt(opened.planId), amount: repayAmount, expectedRepaid: loan.totalRepaid, nonce: engineNonce, deadline: repayDeadline },
  });
  const repaid = await relay({ type: "repay", loanId: opened.planId, amount: String(repayAmount), expectedRepaid: String(loan.totalRepaid), deadline: String(repayDeadline), signature: repaySig });
  await onChain(`Pay an instalment early, ${usd(repayAmount)}: PolarisLoanEngine.repayWithSig`, repaid.txHash, { from: relayerAddress, to: C.PolarisLoanEngine, signedBy: "buyer (RepayIntent)", abi: polarisLoanEngineAbi });
  pass("an instalment paid early through the relayer", `(${repaid.txHash})`);

  // ── a lost approval, signed again ──────────────────────────────────────
  const zero = await permit(C.PolarisLoanEngine, 0n);
  const z = parseSignature(zero.signature);
  const revoke = await harness.writeContract({
    address: C.Stablecoin,
    abi: mockAUSDAbi,
    functionName: "permit",
    args: [buyer.address, C.PolarisLoanEngine, 0n, zero.deadline, Number(z.v ?? BigInt(z.yParity + 27)), z.r, z.s],
  });
  await onChain("Harness: a lost approval (the buyer's signed permit(0) to the loan engine, submitted by the deployer)", revoke, { from: deployer.address, to: C.Stablecoin, signedBy: "buyer (Permit, value 0)", abi: mockAUSDAbi });
  const owed = await client.readContract({ address: C.PolarisLoanEngine, abi: polarisLoanEngineAbi, functionName: "activeDebtOf", args: [buyer.address] });
  const again = await permit(C.PolarisLoanEngine, owed);
  const re = await relay({ type: "reauthorize", buyer: buyer.address, permit: again.body });
  const reTx = await onChain("The buyer signs again: PolarisCheckout.reauthorize (Reauthorized: the CRE collections log trigger)", re.txHash, { from: relayerAddress, to: C.PolarisCheckout, signedBy: "buyer (Permit to the loan engine)", abi: polarisCheckoutAbi });
  assert(reTx.row.events.includes("Reauthorized"), "PolarisCheckout emitted Reauthorized");
  pass("a lost approval signed again, Reauthorized emitted", `(${re.txHash})`);

  // ── Send by link, and its claim ────────────────────────────────────────
  const sendAmount = BigInt(SEND_USD) * 1_000_000n;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const sendValidBefore = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const sendNonce = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [linkKey.address, expiresAt]));
  const sendAuth = await buyer.signTypedData({
    domain: tokenDomain,
    types: TYPES.ReceiveWithAuthorization,
    primaryType: "ReceiveWithAuthorization",
    message: { from: buyer.address, to: C.PolarisSend, value: sendAmount, validAfter: 0n, validBefore: sendValidBefore, nonce: sendNonce },
  });
  const openSig = await linkKey.signTypedData({ domain: polarisDomain("send", 10143, C.PolarisSend), types: TYPES.Open, primaryType: "Open", message: { sender: buyer.address, amount: sendAmount, expiresAt } });
  const sent = await relay({
    type: "send",
    sender: buyer.address,
    linkKey: linkKey.address,
    amount: String(sendAmount),
    expiresAt: String(expiresAt),
    validAfter: "0",
    validBefore: String(sendValidBefore),
    signature: sendAuth,
    linkSignature: openSig,
  });
  await onChain(`Send ${usd(sendAmount)} by link: PolarisSend.send`, sent.txHash, { from: relayerAddress, to: C.PolarisSend, signedBy: "sender (ReceiveWithAuthorization) + link key (Open)", abi: polarisSendAbi });
  const claimDeadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const claimSig = await linkKey.signTypedData({ domain: polarisDomain("send", 10143, C.PolarisSend), types: TYPES.Claim, primaryType: "Claim", message: { to: recipient.address, deadline: claimDeadline } });
  const claimed = await relay({ type: "claim", linkKey: linkKey.address, to: recipient.address, deadline: String(claimDeadline), signature: claimSig });
  await onChain("The link is claimed on a new phone: PolarisSend.claim", claimed.txHash, { from: relayerAddress, to: C.PolarisSend, signedBy: "link key (Claim naming the recipient)", abi: polarisSendAbi });
  const got = await client.readContract({ address: C.Stablecoin, abi: mockAUSDAbi, functionName: "balanceOf", args: [recipient.address] });
  assert(got === sendAmount, `the recipient holds ${usd(sendAmount)} (has ${usd(got)})`);
  pass("sent by link and claimed by a recipient with no MON", `(${usd(got)} received)`);

  // ── Cancel the subscription ────────────────────────────────────────────
  const cancelDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const cancelSig = await buyer.signTypedData({
    domain: polarisDomain("payments", 10143, C.PolarisPayments),
    types: TYPES.CancelSubscription,
    primaryType: "CancelSubscription",
    message: { subId: BigInt(subId), deadline: cancelDeadline },
  });
  const canceled = await relay({ type: "cancelSubscription", subId: String(subId), deadline: String(cancelDeadline), signature: cancelSig });
  await onChain("Cancel the subscription: PolarisPayments.cancelWithSignature", canceled.txHash, { from: relayerAddress, to: C.PolarisPayments, signedBy: "subscriber (CancelSubscription)", abi: polarisPaymentsAbi });
  pass("subscription cancelled by signature", `(${canceled.txHash})`);

  // ── The merchant's one-tap withdraw ────────────────────────────────────
  const merchantBalance = await client.readContract({ address: C.Stablecoin, abi: mockAUSDAbi, functionName: "balanceOf", args: [merchant.address] });
  const withdrawUnits = BigInt(WITHDRAW_USD) * 1_000_000n;
  assert(merchantBalance >= withdrawUnits, `the merchant holds at least ${usd(withdrawUnits)} (has ${usd(merchantBalance)})`);
  const wNonce = toHex(randomBytes(32));
  const wBefore = BigInt(Math.floor(Date.now() / 1000) + 900);
  const wSig = await merchant.signTypedData({
    domain: tokenDomain,
    types: TYPES.TransferWithAuthorization,
    primaryType: "TransferWithAuthorization",
    message: { from: merchant.address, to: payout.address, value: withdrawUnits, validAfter: 0n, validBefore: wBefore, nonce: wNonce },
  });
  const withdrawn = await relay({ type: "transfer", from: merchant.address, to: payout.address, value: String(withdrawUnits), validAfter: "0", validBefore: String(wBefore), nonce: wNonce, signature: wSig });
  await onChain(`The merchant withdraws ${usd(withdrawUnits)} in one tap: AUSD transferWithAuthorization`, withdrawn.txHash, { from: relayerAddress, to: C.Stablecoin, signedBy: "merchant (TransferWithAuthorization)", abi: mockAUSDAbi });
  const out = await client.readContract({ address: C.Stablecoin, abi: mockAUSDAbi, functionName: "balanceOf", args: [payout.address] });
  assert(out === withdrawUnits, `the payout address holds ${usd(withdrawUnits)}`);
  pass("merchant withdrew to its payout address with no MON", `(${usd(merchantBalance)} earned, ${usd(out)} withdrawn)`);

  // ── The operator's price pins, read back too ───────────────────────────
  for (const q of await relaysOfKind(dbUrl, "quoteOrder")) {
    await onChain("The session's price pinned on its order: PolarisPayments.quoteOrder (operator)", q.txHash, { from: relayerAddress, to: C.PolarisPayments, signedBy: "none (operator: the session's price)", abi: polarisPaymentsAbi });
  }

  // ── checks ─────────────────────────────────────────────────────────────
  const bad = received.filter((r) => r.error);
  assert(bad.length === 0, `every delivery verified (${bad.map((b) => b.error).join("; ")})`);
  for (const u of users) {
    u.monAfter = await client.getBalance({ address: u.account.address });
    u.nonceAfter = await client.getTransactionCount({ address: u.account.address });
    assert(u.monAfter === 0n && u.nonceAfter === 0, `${u.role} ${u.account.address} ends with no MON and no transactions (MON ${u.monAfter}, nonce ${u.nonceAfter})`);
  }
  const relayed = steps.filter((s) => s.from === getAddress(relayerAddress));
  for (const s of relayed) assert(s.status === 1, `${s.what} landed`);
  const relayerNonce1 = await client.getTransactionCount({ address: relayerAddress });
  const relayerMon1 = await client.getBalance({ address: relayerAddress });
  const activatorMon1 = activatorAddress ? await client.getBalance({ address: activatorAddress }) : null;
  pass("the five users never held MON and never sent a transaction; every step was a signature the relayer carried", `(relayer: ${relayerNonce1 - relayerNonce0} transactions, ${formatEther(relayerMon0 - relayerMon1)} MON)`);

  hooks.close();
  const result = {
    at: new Date().toISOString(),
    chainId: 10143,
    network: "Monad testnet",
    note:
      "Written by pnpm --filter @polaris/business smoke:testnet -- --run. The dollar is MockAUSD, a labelled mock for the testnet demo. " +
      "Every account under `users` was generated for this run and never held MON. The buyer's Pay in 4 line is secured by collateral locked with a relayed permit " +
      "(CollateralVault.lockWithPermit): an unsecured line needs a CRE underwriting report, which a fresh account can't get (requireUnderwriting is on). " +
      "The merchant's registration is its Registration signature relayed as registerFor (the dashboard's route needs a Privy login); its withdraw is its " +
      "TransferWithAuthorization relayed as transferWithAuthorization (what the dashboard's Withdraw relays). Harness rows are test setup by the deployer.",
    relayer: {
      mode,
      address: getAddress(relayerAddress),
      walletId: mode === "privy" ? appEnv.PRIVY_RELAYER_WALLET_ID : null,
      policyId: mode === "privy" ? appEnv.PRIVY_RELAYER_POLICY_ID ?? null : null,
      transactions: relayerNonce1 - relayerNonce0,
      monSpent: formatEther(relayerMon0 - relayerMon1),
    },
    activator: activatorAddress ? { address: activatorAddress, walletId: appEnv.PRIVY_REGISTRY_WALLET_ID ?? null, monSpent: formatEther(activatorMon0 - activatorMon1) } : null,
    harness: deployer.address,
    merchant: { address: merchant.address, name: seeded.merchant.businessName, payoutAddress: payout.address, earned: formatUnits(merchantBalance, 6), withdrawn: formatUnits(out, 6) },
    users: users.map((u) => ({
      role: u.role,
      address: u.account.address,
      monBefore: formatEther(u.monBefore),
      monAfter: formatEther(u.monAfter),
      nonceBefore: u.nonceBefore,
      nonceAfter: u.nonceAfter,
    })),
    payNow: { sessionId: s1.id, orderId: orderNow, txHash: paid.txHash, webhook: payEvent.event.id },
    collateral: { amount: formatUnits(collateral, 6), txHash: locked.txHash, creditLimit: formatUnits(limit, 6) },
    payIn4: { sessionId: s2.id, orderId: orderPlan, planId: opened.planId, intervalSeconds: INTERVAL, txHash: opened.txHash, webhook: planEvent.event.id, schedule: planEvent.event.data.schedule },
    subscription: { sessionId: s3.id, orderId: orderSub, planId: pub3.subscription.planId, subscriptionId: String(subId), txHash: subscribed.txHash, canceledTxHash: canceled.txHash, webhook: subEvent?.event.id ?? null },
    repay: { planId: opened.planId, amount: formatUnits(repayAmount, 6), txHash: repaid.txHash },
    reauthorize: { txHash: re.txHash, evidence: `pnpm --filter @polaris/cre-workflows evidence --retry-tx ${re.txHash}` },
    send: { linkKey: linkKey.address, amount: formatUnits(sendAmount, 6), txHash: sent.txHash, claimTxHash: claimed.txHash, recipient: recipient.address },
    withdraw: { from: merchant.address, to: payout.address, amount: formatUnits(out, 6), txHash: withdrawn.txHash },
    registration: { txHash: regHash, activation: activation?.map((a) => a.txHash) ?? [] },
    webhooks: received.filter((r) => r.event).map((r) => ({ type: r.event.type, id: r.event.id })),
    steps,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, "README.md"), markdownFrom(result));
  log(`\nAll ${n} checks passed. Every hash: docs/demo/testnet/results.json and README.md`);
  log("\n| Step | Sent by | Transaction |\n|---|---|---|");
  for (const s of steps) log(`| ${s.what} | ${s.by} | [${s.txHash.slice(0, 10)}…](${s.explorer}) |`);
}

/** What the server's relayer sent of one kind, from its own store (id, txHash), oldest first. */
export async function relaysOfKind(dbUrl, kind) {
  const { collections, openStore } = await import("@polaris/db");
  // The server has the same SQLite file open: a read that meets its write lock is tried again.
  for (let attempt = 0; ; attempt++) {
    let store = null;
    try {
      store = openStore(dbUrl);
      // `kind` is not an indexed field of relays: read them all (a smoke run's store holds a few dozen).
      const rows = await collections(store).relays.find({}, { orderBy: "createdAt" });
      return rows
        .filter((r) => r.kind === kind && r.txHash && r.state !== "failed")
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map((r) => ({ id: r.id, txHash: r.txHash, to: r.to }));
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    } finally {
      store?.close();
    }
  }
}

/**
 * Send one call as the relayer from this script (the merchant's registerFor,
 * which the dashboard's Privy-authenticated route would otherwise send):
 * simulate, estimate + 15% (Monad bills the limit), sign (Privy's enclave,
 * under the relayer policy, or the dev key), broadcast.
 */
async function sendAsRelayer({ mode, client, chain, to, data, relayerAddress, localKey, appEnv }) {
  let account;
  if (mode === "privy") {
    const { PrivyClient } = await import("@privy-io/node");
    const { createViemAccount } = await import("@privy-io/node/viem");
    const privy = new PrivyClient({ appId: appEnv.PRIVY_APP_ID || appEnv.NEXT_PUBLIC_PRIVY_APP_ID, appSecret: appEnv.PRIVY_APP_SECRET });
    account = createViemAccount(privy, {
      walletId: appEnv.PRIVY_RELAYER_WALLET_ID,
      address: getAddress(relayerAddress),
      authorizationContext: { authorization_private_keys: [appEnv.PRIVY_RELAYER_AUTH_KEY] },
    });
  } else {
    account = privateKeyToAccount(localKey);
  }
  await client.call({ account: account.address, to, data });
  const [estimate, fees, nonce] = await Promise.all([
    client.estimateGas({ account: account.address, to, data }),
    client.estimateFeesPerGas({ type: "eip1559" }),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
  ]);
  const raw = await account.signTransaction({
    type: "eip1559",
    chainId: chain.id,
    to,
    data,
    nonce,
    gas: (estimate * 11_500n) / 10_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return client.sendRawTransaction({ serializedTransaction: raw });
}

function stopAll() {
  for (const { child } of children) {
    try {
      if (child.exitCode !== null) continue;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch {
      // gone
    }
  }
}

if (process.argv[1] && /smoke-testnet\.mjs$/.test(process.argv[1])) {
  main()
    .catch((error) => {
      console.error(`\nFAILED: ${error.message}`);
      if (steps.length) console.error(`Sent before the failure:\n${steps.map((s) => `  ${s.what}: ${s.txHash}`).join("\n")}`);
      for (const { name, lines } of children) console.error(`\n── last lines of ${name} ──\n${lines.slice(-60).join("\n")}`);
      process.exitCode = 1;
    })
    .finally(() => {
      stopAll();
      setTimeout(() => {
        try {
          if (work) rmSync(work, { recursive: true, force: true });
        } catch {
          // Windows may still hold the database for a moment
        }
        process.exit(process.exitCode ?? 0);
      }, 1500);
    });
}
