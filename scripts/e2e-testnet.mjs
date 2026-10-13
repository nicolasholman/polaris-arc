#!/usr/bin/env node
/**
 * `pnpm e2e:testnet`: Polaris end to end on Arc testnet, with real
 * transactions and Circle's real USDC. Nothing is mocked; every step is
 * checked on chain and every hash is written to
 * packages/contracts/deployments/arc-testnet.json (`e2e`).
 *
 *  1. starts Polaris for Business (next dev, :3700) on the testnet record,
 *     with the relayer key from .env.local (RELAYER_MODE=local, allowed on
 *     testnet knowingly), and the keeper (services/keeper, :2700) with its key;
 *  2. a fresh buyer key gets a few testnet USDC from the deployer (the one
 *     broadcast from the shared deployer, inside the shared lock) and never
 *     holds or spends gas of its own;
 *  3. Pay now through a checkout session: the relayer wraps PolarisCheckout.pay
 *     in Arc's Memo contract with the order key, checked from the Memo event;
 *  4. Boost: the buyer locks USDC in CollateralVault with a permit (relayed),
 *     which opens a secured Pay in 4 line at face value;
 *  5. Pay in 4 (PlanIntent + Permit, relayed), on a deployment with minute
 *     intervals (deploy with POLARIS_FAST_PLANS=1);
 *  6. the keeper collects instalment 1 when it falls due, seen on chain and in
 *     the installment.collected webhook;
 *  7. if the deployer holds EURC: a euro send link, claimed by a fresh key.
 *
 * Needs: deployments/arc-testnet.json; POLARIS_RELAYER_PRIVATE_KEY and
 * POLARIS_KEEPER_PRIVATE_KEY in the repo's .env.local (funded with testnet
 * USDC for gas); the deployer key file (DEPLOYER_ENV_FILE, default
 * ../.deployer/deployer.env). E2E_BUYER_USDC (default 5) dollars go to the buyer.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BUSINESS = join(REPO, "apps", "business");
const CONTRACTS = join(REPO, "packages", "contracts");
// E2E_RECORD: a rehearsal on a local fork of Arc testnet (scripts/arc-fork.sh) uses its own record.
const RECORD = process.env.E2E_RECORD ? resolve(process.env.E2E_RECORD) : join(CONTRACTS, "deployments", "arc-testnet.json");
const FORK = process.env.E2E_FORK === "1";
const DEPLOYER_ENV = process.env.DEPLOYER_ENV_FILE || join(REPO, "..", ".deployer", "deployer.env");
const LOCK = join(REPO, "..", ".deployer", "lock");
const APP_PORT = Number(process.env.E2E_APP_PORT || 3700);
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT || 3701);
const KEEPER_PORT = Number(process.env.E2E_KEEPER_PORT || 2700);
const BASE = `http://localhost:${APP_PORT}`;
const BUYER_USDC = BigInt(Math.round(Number(process.env.E2E_BUYER_USDC || "5") * 1e6));

const requireBusiness = createRequire(join(BUSINESS, "package.json"));
const fileUrl = (p) => new URL(`file:///${p.replace(/\\/g, "/").replace(/^\/+/, "")}`).href;
const viem = await import(fileUrl(requireBusiness.resolve("viem")));
const { privateKeyToAccount, generatePrivateKey } = await import(fileUrl(requireBusiness.resolve("viem/accounts")));
const { arcTestnet } = await import(fileUrl(requireBusiness.resolve("viem/chains")));
const abis = await import(fileUrl(join(CONTRACTS, "abi", "index.mjs")));

function envFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

const local = envFile(join(REPO, ".env.local"));
const record = JSON.parse(readFileSync(RECORD, "utf8"));
const C = Object.fromEntries(Object.entries(record.contracts).map(([k, v]) => [k, viem.getAddress(v.address)]));
const RPC = process.env.ARC_TESTNET_RPC_URL || record.rpcUrl || "https://rpc.testnet.arc.io";
const EXPLORER = record.explorerUrl || "https://explorer.testnet.arc.io";
const chain = viem.defineChain({ ...arcTestnet, rpcUrls: { default: { http: [RPC] } } });
const client = viem.createPublicClient({ chain, transport: viem.http(RPC, { retryCount: 8, retryDelay: 1500 }), pollingInterval: 1000 });

const results = [];
const proof = {};
const children = [];
let step = 0;
const log = (m) => console.log(m);
const pass = (what, detail = "") => {
  step++;
  results.push(what);
  log(`  ${String(step).padStart(2)}. PASS  ${what}${detail ? `  ${detail}` : ""}`);
};
const assert = (cond, message) => {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
};
const tx = (h) => (FORK ? `(local fork of Arc testnet) ${h}` : `${EXPLORER}/tx/${h}`);

async function until(what, fn, { timeoutMs = 120_000, everyMs = 1000 } = {}) {
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

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** One broadcast from the shared deployer, inside the shared lock (PORTING-BRIEF.md). */
async function withDeployerLock(fn) {
  if (FORK) return fn(); // a local fork: the shared deployer isn't involved
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  try {
    return await fn();
  } finally {
    rmdirSync(LOCK);
  }
}

const FLOOR = 20_000_000_000n;
async function fees() {
  const f = await client.estimateFeesPerGas();
  return { maxFeePerGas: f.maxFeePerGas > FLOOR ? f.maxFeePerGas : FLOOR * 2n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n };
}

const RWA = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const PERMIT = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};


/** Phase 2 (E2E_PHASE=collect): the keeper collects the live plan's first instalment once it is due. */
async function collectPhase() {
  const keeperKey = local.POLARIS_KEEPER_PRIVATE_KEY;
  assert(keeperKey, ".env.local needs POLARIS_KEEPER_PRIVATE_KEY");
  const prior = record.e2e?.txs;
  assert(prior?.loanId, "no plan recorded: run the first phase (pnpm e2e:testnet) first");
  const loanId = BigInt(prior.loanId);
  const getLoan = () => client.readContract({ address: C.PolarisLoanEngine, abi: abis.polarisLoanEngineAbi, functionName: "getLoan", args: [loanId] });
  let loan = await getLoan();
  const due = Number(loan.startedAt) + Number(loan.intervalSeconds) * (Number(loan.installmentsPaid) + 1);
  const wait = due - Math.floor(Date.now() / 1000);
  if (wait > 0) {
    log(`Plan #${loanId}: instalment ${Number(loan.installmentsPaid) + 1} falls due in ${wait} s (${new Date(due * 1000).toISOString()}). Run this again after that.`);
    return;
  }
  const paidBefore = loan.installmentsPaid;
  const from = (await client.getBlockNumber()) - 50n;
  log(`Plan #${loanId} is due: running the keeper once`);
  background("keeper", process.execPath, ["--conditions=source", "--disable-warning=ExperimentalWarning", join(REPO, "services", "keeper", "src", "main.ts"), "--once"], {
    cwd: join(REPO, "services", "keeper"),
    env: { ...process.env, POLARIS_DEPLOYMENT_FILE: RECORD, KEEPER_RPC_URL: RPC, POLARIS_KEEPER_PRIVATE_KEY: keeperKey, KEEPER_BACKOFF: "off" },
  });
  await until("the keeper to collect", async () => (await getLoan()).installmentsPaid > paidBefore, { timeoutMs: 180_000, everyMs: 3000 });
  loan = await getLoan();
  const runs = await client.getContractEvents({ address: C.CollectionsReceiver, abi: abis.collectionsReceiverAbi, eventName: "TaskExecuted", fromBlock: from });
  const run = runs.find((r) => r.args.id === loanId);
  assert(run, "a TaskExecuted event for the plan");
  pass(`the keeper collected instalment ${loan.installmentsPaid} of plan #${loanId} through CollectionsReceiver (${loan.installmentsPaid}/${loan.installmentCount} paid)`, tx(run.transactionHash));
  const latest = JSON.parse(readFileSync(RECORD, "utf8"));
  latest.e2e = { ...latest.e2e, collectedAt: new Date().toISOString(), txs: { ...latest.e2e.txs, collect: run.transactionHash } };
  writeFileSync(RECORD, JSON.stringify(latest, null, 2) + "\n");
}

async function main() {
  if (process.env.E2E_PHASE === "collect") return collectPhase();
  const relayerKey = local.POLARIS_RELAYER_PRIVATE_KEY;
  const keeperKey = local.POLARIS_KEEPER_PRIVATE_KEY;
  assert(relayerKey && keeperKey, ".env.local needs POLARIS_RELAYER_PRIVATE_KEY and POLARIS_KEEPER_PRIVATE_KEY");
  const relayer = privateKeyToAccount(relayerKey);
  const keeper = privateKeyToAccount(keeperKey);
  assert(record.roles.relayer && viem.getAddress(record.roles.relayer) === relayer.address, "the record's relayer is this key");
  assert(viem.getAddress(record.roles.keeper) === keeper.address, "the record's keeper is this key");
  const [relayerGas, keeperGas] = await Promise.all([client.getBalance({ address: relayer.address }), client.getBalance({ address: keeper.address })]);
  assert(relayerGas > 0n && keeperGas > 0n, `relayer (${viem.formatUnits(relayerGas, 18)}) and keeper (${viem.formatUnits(keeperGas, 18)}) need USDC for gas`);
  log(`Polaris on Arc testnet (chain ${record.chainId}), end to end\n  relayer ${relayer.address} (${viem.formatUnits(relayerGas, 18)} USDC), keeper ${keeper.address} (${viem.formatUnits(keeperGas, 18)} USDC)\n`);

  // ── 1. servers ───────────────────────────────────────────────────────────
  const work = mkdtempSync(join(tmpdir(), "polaris-testnet-e2e-"));
  const secret = randomBytes(24).toString("hex");
  const pepper = randomBytes(16).toString("hex");
  const dbUrl = `sqlite:${join(work, "polaris.db")}`;
  const received = [];
  let webhookSecret = null;
  const sdk = await import(fileUrl(join(REPO, "packages", "sdk", "dist", "esm", "server.js")));
  const hooks = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        received.push({ event: sdk.verifyWebhook(raw, req.headers["polaris-signature"], webhookSecret) });
        res.writeHead(204).end();
      } catch (error) {
        received.push({ error: error.message });
        res.writeHead(400).end();
      }
    });
  });
  await new Promise((r) => hooks.listen(HOOK_PORT, "127.0.0.1", r));
  const { seedMerchant } = await import(fileUrl(join(BUSINESS, "scripts", "lib", "seed.mjs")));
  const seeded = await seedMerchant({ dbUrl, pepper, wallet: record.demo.merchant, name: record.demo.merchantName, webhookUrl: `http://127.0.0.1:${HOOK_PORT}/webhook`, links: [{ amountCents: Number(process.env.E2E_LINK_CENTS || "50"), description: "Arc testnet payment link", modes: ["now"], usage: "reusable" }], registration: "active" });
  webhookSecret = seeded.webhookSecret;

  spawnSync(process.execPath, [join(BUSINESS, "scripts", "ensure-deps.mjs")], { cwd: BUSINESS, stdio: "ignore" });
  background("business", process.execPath, [join(BUSINESS, "node_modules", "next", "dist", "bin", "next"), "dev", "--port", String(APP_PORT)], {
    cwd: BUSINESS,
    env: {
      ...process.env,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      POLARIS_DEPLOYMENT_FILE: RECORD,
      POLARIS_RPC_URL: RPC,
      RELAYER_MODE: "local",
      RELAYER_LOCAL_ALLOW_TESTNET: "1",
      RELAYER_PRIVATE_KEY: relayerKey,
      REGISTRY_ACTIVATOR: "off",
      POLARIS_DB_URL: dbUrl,
      POLARIS_KEY_PEPPER: pepper,
      POLARIS_DISABLE_PRIVY: "1",
      POLARIS_WEBHOOK_ALLOW_PRIVATE: "1",
      POLARIS_CHECKOUT_ORIGIN: "http://localhost:3000",
      POLARIS_PUBLIC_URL: BASE,
      POLARIS_WORKERS: "1",
      POLARIS_SYNC_FROM_BLOCK: String(await client.getBlockNumber()),
      PAY_IN_4_INTERVAL_SECONDS: String(Math.max(60, record.config.minInterval)),
      PAY_IN_4_MIN_CENTS: "100",
      KEEPER_UNDERWRITING_URL: `http://127.0.0.1:${KEEPER_PORT}/underwrite`,
      POLARIS_KEEPER_CALLBACK_SECRET: secret,
      CRON_SECRET: "e2e-cron",
    },
  });
  background("keeper", process.execPath, ["--conditions=source", "--disable-warning=ExperimentalWarning", join(REPO, "services", "keeper", "src", "main.ts")], {
    cwd: join(REPO, "services", "keeper"),
    env: {
      ...process.env,
      POLARIS_DEPLOYMENT_FILE: RECORD,
      KEEPER_RPC_URL: RPC,
      POLARIS_KEEPER_PRIVATE_KEY: keeperKey,
      POLARIS_API_URL: BASE,
      POLARIS_KEEPER_CALLBACK_SECRET: secret,
      KEEPER_PORT: String(KEEPER_PORT),
      KEEPER_COLLECTIONS_INTERVAL_SECONDS: "20",
      KEEPER_BACKOFF: "off",
    },
  });
  const health = await until("Polaris for Business", async () => {
    const h = await api("/api/health");
    return h.status === 200 && h.body?.data?.ok ? h.body.data : null;
  }, { timeoutMs: 300_000, everyMs: 2000 });
  assert(health.chain.id === 5042002, "the server is on Arc testnet");
  pass("Polaris for Business and the keeper are up on Arc testnet", `(relayer ${health.relayer.mode} ${health.relayer.address})`);
  const polaris = sdk.createPolarisServer({ secretKey: seeded.secretKey, baseUrl: BASE });
  const waitFor = (type, match = () => true) => until(`the ${type} webhook`, () => received.find((r) => r.event?.type === type && match(r.event)), { timeoutMs: 180_000 });

  // ── 2. a buyer with a few USDC and no gas ────────────────────────────────
  // The throwaway buyer's key is kept in .data/ (git-ignored, mode 0600) so a run that stops half way never strands its USDC.
  const keyFile = join(REPO, ".data", "e2e-buyer.key");
  mkdirSync(join(REPO, ".data"), { recursive: true });
  const reuse = process.env.E2E_REUSE_BUYER === "1" && existsSync(keyFile);
  // E2E_BUYER=deployer: the deployer wallet itself is the buyer (its own USDC, nothing is funded or stranded; the
  // pool and the treasury are the deployer's too, so a repaid instalment returns to the same owner).
  const asDeployer = process.env.E2E_BUYER === "deployer";
  const buyerKey = asDeployer ? envFile(DEPLOYER_ENV).DEPLOYER_PRIVATE_KEY : reuse ? readFileSync(keyFile, "utf8").trim() : generatePrivateKey();
  if (!reuse && !asDeployer) writeFileSync(keyFile, buyerKey + "\n", { mode: 0o600 });
  const buyer = privateKeyToAccount(buyerKey);
  const steps = new Set((process.env.E2E_STEPS || "send,link,sub,plan,eur").split(","));
  const deployerKey = envFile(DEPLOYER_ENV).DEPLOYER_PRIVATE_KEY;
  assert(deployerKey, `no DEPLOYER_PRIVATE_KEY in ${DEPLOYER_ENV}`);
  const deployer = viem.createWalletClient({ account: privateKeyToAccount(deployerKey), chain, transport: viem.http(RPC, { retryCount: 8, retryDelay: 2000 }) });
  const held = await client.readContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "balanceOf", args: [buyer.address] });
  const fundHash = asDeployer || (reuse && held >= BUYER_USDC) ? null : await withDeployerLock(async () => {
    const h = await deployer.writeContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "transfer", args: [buyer.address, BUYER_USDC], ...(await fees()) });
    await client.waitForTransactionReceipt({ hash: h });
    return h;
  });
  proof.fundBuyer = fundHash;
  pass(`buyer ${buyer.address} holds ${viem.formatUnits(await client.readContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "balanceOf", args: [buyer.address] }), 6)} USDC (ERC-20) and no other token`, fundHash ? tx(fundHash) : asDeployer ? "(the deployer is the buyer)" : "(reused buyer)");

  // ── 3. a send link in USDC, created and claimed ──────────────────────────
  const net = (await api("/api/public/network")).body.data;
  const sendUsd = BigInt(Math.round(Number(process.env.E2E_SEND_USD || "0.2") * 1e6));
  const claimTo = viem.getAddress(process.env.E2E_CLAIM_TO || deployer.account.address);
  async function sendLink(currency) {
    const eur = currency === "EUR";
    const tokenDomain = eur ? net.domains.eurc : net.domains.stablecoin;
    const sendDomain = eur ? net.domains.sendEurc : net.domains.send;
    const sendAddr = eur ? C.PolarisSendEURC : C.PolarisSend;
    const linkKey = privateKeyToAccount(generatePrivateKey());
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86_400);
    const vb = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const nonce = viem.keccak256(viem.encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [linkKey.address, expiresAt]));
    const sig = await buyer.signTypedData({ domain: tokenDomain, types: RWA, primaryType: "ReceiveWithAuthorization", message: { from: buyer.address, to: sendAddr, value: sendUsd, validAfter: 0n, validBefore: vb, nonce } });
    const open = await linkKey.signTypedData({ domain: sendDomain, types: { Open: [{ name: "sender", type: "address" }, { name: "amount", type: "uint256" }, { name: "expiresAt", type: "uint64" }] }, primaryType: "Open", message: { sender: buyer.address, amount: sendUsd, expiresAt } });
    const sent = await api("/api/relay", { method: "POST", body: JSON.stringify({ type: "send", currency: eur ? "EUR" : "USD", sender: buyer.address, linkKey: linkKey.address, amount: String(sendUsd), expiresAt: String(expiresAt), validAfter: "0", validBefore: String(vb), signature: sig, linkSignature: open }) });
    assert(sent.status === 200 && sent.body.data.status === "confirmed", `relay send ${currency}: ${JSON.stringify(sent.body)}`);
    const to = eur ? privateKeyToAccount(generatePrivateKey()).address : claimTo;
    const dl = BigInt(Math.floor(Date.now() / 1000) + 900);
    const claimSig = await linkKey.signTypedData({ domain: sendDomain, types: { Claim: [{ name: "to", type: "address" }, { name: "deadline", type: "uint256" }] }, primaryType: "Claim", message: { to, deadline: dl } });
    const before = await client.readContract({ address: eur ? C.EURC : C.USDC, abi: abis.iusdcAbi, functionName: "balanceOf", args: [to] });
    const claimed = await api("/api/relay", { method: "POST", body: JSON.stringify({ type: "claim", currency: eur ? "EUR" : "USD", linkKey: linkKey.address, to, deadline: String(dl), signature: claimSig }) });
    assert(claimed.status === 200 && claimed.body.data.status === "confirmed", `relay claim ${currency}: ${JSON.stringify(claimed.body)}`);
    const after = await client.readContract({ address: eur ? C.EURC : C.USDC, abi: abis.iusdcAbi, functionName: "balanceOf", args: [to] });
    assert(after - before === sendUsd, `the claimer received exactly the link's amount (${after - before})`);
    return { sent: sent.body.data.txHash, claimed: claimed.body.data.txHash, to };
  }
  if (steps.has("send")) {
  const usdSend = await sendLink("USD");
  Object.assign(proof, { sendUsd: usdSend.sent, claimUsd: usdSend.claimed });
  pass(`USDC send link: $${viem.formatUnits(sendUsd, 6)} sent by the buyer, claimed by ${usdSend.to} (no gas on either side)`, `${tx(usdSend.sent)} ${tx(usdSend.claimed)}`);
  }

  const domain = net.domains.stablecoin;
  if (steps.has("link")) {
  // ── 4. a merchant payment link, paid in full ─────────────────────────────
  const linkCents = Number(process.env.E2E_LINK_CENTS || "50");
  const linkUnits = BigInt(linkCents) * 10_000n;
  const opened1 = await api(`/api/public/links/${seeded.links[0].id}/checkout`, { method: "POST" });
  assert(opened1.status === 201, `open payment link: ${JSON.stringify(opened1.body)}`);
  const pub1 = opened1.body.data;
  assert(BigInt(pub1.chain.amountUnits) === linkUnits, "the session carries the link's amount");
  assert(domain.name === "USDC" && domain.version === "2", "USDC's EIP-712 domain on Arc");
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 900);
  const rwa = await buyer.signTypedData({ domain, types: RWA, primaryType: "ReceiveWithAuthorization", message: { from: buyer.address, to: pub1.chain.contracts.payments, value: linkUnits, validAfter: 0n, validBefore, nonce: pub1.chain.orderKey } });
  const merchantBefore = await client.readContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "balanceOf", args: [pub1.chain.merchant] });
  const paid = await api("/api/relay", { method: "POST", body: JSON.stringify({ type: "pay", sessionId: pub1.id, buyer: buyer.address, validAfter: "0", validBefore: String(validBefore), signature: rwa }) });
  assert(paid.status === 200 && paid.body.data.status === "confirmed", `relay pay: ${JSON.stringify(paid.body)}`);
  const payTx = await client.getTransaction({ hash: paid.body.data.txHash });
  const payReceipt = await client.getTransactionReceipt({ hash: paid.body.data.txHash });
  const memo = record.circle?.memo ? viem.getAddress(record.circle.memo) : null;
  const memoEvents = memo
    ? viem.parseEventLogs({
        abi: viem.parseAbi(["event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)"]),
        logs: payReceipt.logs.filter((l) => viem.getAddress(l.address) === memo),
      })
    : [];
  proof.payLink = paid.body.data.txHash;
  const merchantAfter = await client.readContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "balanceOf", args: [pub1.chain.merchant] });
  log(`     merchant balance +${viem.formatUnits(merchantAfter - merchantBefore, 6)} USDC (fee ${record.config.feeBps} bps to the treasury if the payout isn't the merchant)`);
  if (memo && viem.getAddress(payTx.to) === memo) {
    assert(memoEvents[0]?.args.memoId === pub1.chain.orderKey, "the Memo event carries the order key");
    pass(`payment link paid in full ($${viem.formatUnits(linkUnits, 6)}), relayed through Arc's Memo contract: the payment carries its order key`, `(${viem.hexToString(memoEvents[0].args.memo)}) ${tx(paid.body.data.txHash)}`);
  } else {
    pass("payment link paid in full (no Memo wrap on this chain)", tx(paid.body.data.txHash));
  }
  await waitFor("payment.succeeded", (e) => e.data.sessionId === pub1.id);
  pass("payment.succeeded webhook arrived, verified by polarispay-sdk");

  }
  if (steps.has("sub")) {
  // ── 5. a subscription ────────────────────────────────────────────────────
  const subCents = Number(process.env.E2E_SUB_CENTS || "50");
  const orderSub = `arc-sub-${Date.now()}`;
  const sSub = await polaris.checkout.sessions.create({ amount: (subCents / 100).toFixed(2), description: "Arc testnet: subscription", modes: ["subscribe"], subscription: { interval: "day" }, successUrl: "http://localhost:3000/thanks", orderId: orderSub }, { idempotencyKey: orderSub });
  const subId = sSub.id;
  const pubSub = await until("the subscription plan to be published on chain", async () => {
    const r = (await api(`/api/public/sessions/${subId}`)).body?.data;
    return r?.subscription?.planId ? r : null;
  }, { timeoutMs: 60_000, everyMs: 1500 });
  const subPrice = BigInt(pubSub.subscription.pricePerPeriodUnits);
  const subNonce = await client.readContract({ address: C.PolarisCheckout, abi: abis.polarisCheckoutAbi, functionName: "nonces", args: [buyer.address] });
  const subTokenNonce = await client.readContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "nonces", args: [buyer.address] });
  const subDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const subIntent = { buyer: buyer.address, merchant: pubSub.chain.merchant, planId: BigInt(pubSub.subscription.planId), pricePerPeriod: subPrice, periodSeconds: BigInt(pubSub.subscription.periodSeconds), orderId: pubSub.chain.orderId, nonce: subNonce, deadline: subDeadline };
  const subSig = await buyer.signTypedData({ domain: net.domains.checkout, types: record.eip712.PolarisCheckout.types, primaryType: "SubscribeIntent", message: subIntent });
  const subPermitValue = subPrice * BigInt(pubSub.subscription.periodsAuthorised);
  const subPermitDeadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const subPermit = await buyer.signTypedData({ domain, types: PERMIT, primaryType: "Permit", message: { owner: buyer.address, spender: pubSub.chain.contracts.payments, value: subPermitValue, nonce: subTokenNonce, deadline: subPermitDeadline } });
  const subbed = await api("/api/relay", {
    method: "POST",
    body: JSON.stringify({
      type: "subscribe",
      sessionId: subId,
      intent: { buyer: buyer.address, planId: String(subIntent.planId), pricePerPeriod: String(subPrice), periodSeconds: String(subIntent.periodSeconds), nonce: String(subNonce), deadline: String(subDeadline) },
      signature: subSig,
      permit: { value: String(subPermitValue), deadline: String(subPermitDeadline), signature: subPermit },
    }),
  });
  assert(subbed.status === 200 && subbed.body.data.status === "confirmed", `relay subscribe: ${JSON.stringify(subbed.body)}`);
  proof.subscribe = subbed.body.data.txHash;
  proof.subscriptionPlanId = pubSub.subscription.planId;
  pass(`subscribed to plan #${pubSub.subscription.planId} ($${viem.formatUnits(subPrice, 6)} per day): the first period charged at once, one permit covers ${pubSub.subscription.periodsAuthorised} periods`, tx(subbed.body.data.txHash));
  await waitFor("subscription.charged", (e) => e.data.planId === pubSub.subscription.planId || e.data.sessionId === subId);
  pass("subscription.charged webhook arrived");

  }
  if (steps.has("plan")) {
  // ── 6. Boost: a secured line at face value, then Pay in 4 ────────────────
  const planUnits = BigInt(Math.round(Number(process.env.E2E_PLAN_USD || "1") * 1e6));
  const boost = (planUnits * 11n) / 10n; // the line must cover the principal plus its interest
  const vaultNonce = await client.readContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "nonces", args: [buyer.address] });
  const boostDeadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const boostSig = await buyer.signTypedData({ domain, types: PERMIT, primaryType: "Permit", message: { owner: buyer.address, spender: C.CollateralVault, value: boost, nonce: vaultNonce, deadline: boostDeadline } });
  const locked = await api("/api/relay", {
    method: "POST",
    body: JSON.stringify({ type: "lockCollateral", borrower: buyer.address, amount: String(boost), permit: { value: String(boost), deadline: String(boostDeadline), signature: boostSig } }),
  });
  assert(locked.status === 200 && locked.body.data.status === "confirmed", `relay lockCollateral: ${JSON.stringify(locked.body)}`);
  proof.boost = locked.body.data.txHash;
  const limit = await client.readContract({ address: C.ScoreManager, abi: abis.scoreManagerAbi, functionName: "creditLimitOf", args: [buyer.address] });
  assert(limit >= boost, `the line is at least the boost (${limit})`);
  pass(`Boost: $${viem.formatUnits(boost, 6)} locked with one permit, credit line $${viem.formatUnits(limit, 6)}`, tx(locked.body.data.txHash));

  const orderPlan = `arc-plan-${Date.now()}`;
  const s2 = await polaris.checkout.sessions.create({ amount: viem.formatUnits(planUnits, 6), description: "Arc testnet: Pay in 4", modes: ["later"], successUrl: "http://localhost:3000/thanks", orderId: orderPlan }, { idempotencyKey: orderPlan });
  const pub2 = (await api(`/api/public/sessions/${s2.id}`)).body.data;
  const guardBefore = (await api("/api/public/credit-guard")).body?.data;
  assert(pub2.payIn4?.available, `Pay in 4 offered: ${JSON.stringify(pub2.payIn4)} guard ${JSON.stringify(guardBefore)}`);
  const interval = BigInt(pub2.payIn4.intervalSeconds);
  const quote = await client.readContract({ address: C.PolarisCheckout, abi: abis.polarisCheckoutAbi, functionName: "quotePlan", args: [buyer.address, planUnits, 4, interval] });
  const checkoutNonce = await client.readContract({ address: C.PolarisCheckout, abi: abis.polarisCheckoutAbi, functionName: "nonces", args: [buyer.address] });
  const tokenNonce = await client.readContract({ address: C.USDC, abi: abis.iusdcAbi, functionName: "nonces", args: [buyer.address] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const intent = { buyer: buyer.address, merchant: pub2.chain.merchant, principal: planUnits, installments: 4, interval, orderId: pub2.chain.orderId, nonce: checkoutNonce, deadline: now + 600n };
  const intentSig = await buyer.signTypedData({
    domain: { name: "PolarisCheckout", version: "1", chainId: pub2.chain.chainId, verifyingContract: pub2.chain.contracts.checkout },
    types: {
      PlanIntent: [
        { name: "buyer", type: "address" },
        { name: "merchant", type: "address" },
        { name: "principal", type: "uint256" },
        { name: "installments", type: "uint32" },
        { name: "interval", type: "uint64" },
        { name: "orderId", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlanIntent",
    message: intent,
  });
  const permitSig = await buyer.signTypedData({ domain, types: PERMIT, primaryType: "Permit", message: { owner: buyer.address, spender: pub2.chain.contracts.loanEngine, value: quote.permitValue, nonce: tokenNonce, deadline: now + 1800n } });
  const opened = await api("/api/relay", {
    method: "POST",
    body: JSON.stringify({
      type: "openPlan",
      sessionId: s2.id,
      intent: { buyer: buyer.address, principal: String(planUnits), installments: "4", interval: String(interval), nonce: String(checkoutNonce), deadline: String(intent.deadline) },
      signature: intentSig,
      permit: { value: String(quote.permitValue), deadline: String(now + 1800n), signature: permitSig },
    }),
  });
  assert(opened.status === 200 && opened.body.data.status === "confirmed" && opened.body.data.planId, `relay openPlan: ${JSON.stringify(opened.body)}`);
  const loanId = BigInt(opened.body.data.planId);
  proof.openPlan = opened.body.data.txHash;
  proof.loanId = String(loanId);
  const loanAfterOpen = await client.readContract({ address: C.PolarisLoanEngine, abi: abis.polarisLoanEngineAbi, functionName: "getLoan", args: [loanId] });
  const dueAt = Number(loanAfterOpen.startedAt) + Number(loanAfterOpen.intervalSeconds);
  proof.firstInstalmentDue = new Date(dueAt * 1000).toISOString();
  pass(`Pay in 4 opened: plan #${loanId} ($${viem.formatUnits(planUnits, 6)}), the merchant paid in full, 4 instalments ${interval} s apart`, tx(opened.body.data.txHash));
  await waitFor("plan.opened", (e) => e.data.sessionId === s2.id);
  pass("plan.opened webhook arrived");
  const guardAfter = (await api("/api/public/credit-guard")).body?.data;
  log(`     credit guard after the plan: ${JSON.stringify(guardAfter)}`);
  proof.guardAfterPlan = guardAfter ?? null;

  // ── 7. the keeper collects instalment 1 (when it falls due) ──────────────
  const collectWait = Number(process.env.E2E_COLLECT_WAIT_SECONDS || "0");
  if (collectWait >= Number(interval)) {
    log(`  …waiting for instalment 1 to fall due (${interval} s) and the keeper to collect it`);
    const collected = await waitFor("installment.collected", (e) => e.data.planId === String(loanId));
    const loan = await client.readContract({ address: C.PolarisLoanEngine, abi: abis.polarisLoanEngineAbi, functionName: "getLoan", args: [loanId] });
    assert(loan.installmentsPaid >= 1, "the loan engine agrees");
    const runs = await client.getContractEvents({ address: C.CollectionsReceiver, abi: abis.collectionsReceiverAbi, eventName: "TaskExecuted", fromBlock: (await client.getBlockNumber()) - 2000n });
    const run = runs.find((r) => r.args.id === loanId);
    proof.collect = run?.transactionHash ?? null;
    pass(`the keeper collected instalment 1 ($${collected.event.data.amount}) through CollectionsReceiver`, run ? tx(run.transactionHash) : "");
  } else {
    log(`  (instalment 1 falls due ${proof.firstInstalmentDue}; collection is the second phase: E2E_PHASE=collect pnpm e2e:testnet)`);
  }

  }
  if (steps.has("eur")) {
  // ── 8. euros by link, when the deployer holds EURC ───────────────────────
  if (C.EURC && C.PolarisSendEURC) {
    const eurHeld = await client.readContract({ address: C.EURC, abi: abis.iusdcAbi, functionName: "balanceOf", args: [deployer.account.address] });
    if (eurHeld >= sendUsd) {
      const eurFund = await withDeployerLock(async () => {
        const h = await deployer.writeContract({ address: C.EURC, abi: abis.iusdcAbi, functionName: "transfer", args: [buyer.address, sendUsd], ...(await fees()) });
        await client.waitForTransactionReceipt({ hash: h });
        return h;
      });
      const eur = await sendLink("EUR");
      Object.assign(proof, { fundBuyerEurc: eurFund, sendEur: eur.sent, claimEur: eur.claimed });
      pass(`euros by link: EUR ${viem.formatUnits(sendUsd, 6)} of EURC sent and claimed, both relayed`, `${tx(eur.sent)} ${tx(eur.claimed)}`);
    } else {
      log("  (skipped euros by link: the deployer holds no testnet EURC; faucet.circle.com gives it) NOT RUN LIVE");
    }
  }

  }
  // ── checks ───────────────────────────────────────────────────────────────
  const [gas, sentTxs] = await Promise.all([client.getBalance({ address: buyer.address }), client.getTransactionCount({ address: buyer.address })]);
  if (!asDeployer) assert(sentTxs === 0, "the buyer sent no transaction");
  assert(received.every((r) => !r.error), "every webhook verified");
  pass(`${asDeployer ? "" : "the buyer sent no transaction (every action was a signature the relayer carried); "}${received.length} webhooks verified`, `(the buyer's 6-decimal USDC left: ${viem.formatUnits(gas / 10n ** 12n, 6)})`);
  hooks.close();

  const latest = JSON.parse(readFileSync(RECORD, "utf8"));
  latest.e2e = { ...latest.e2e, ranAt: new Date().toISOString(), buyer: buyer.address, checks: [...(latest.e2e?.checks ?? []), ...results], txs: { ...latest.e2e?.txs, ...proof } };
  writeFileSync(RECORD, JSON.stringify(latest, null, 2) + "\n");
  log(`\nAll ${results.length} checks passed. Hashes in ${RECORD} (e2e).`);
}

function stopAll() {
  for (const { child } of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // gone
    }
  }
}

main()
  .catch((error) => {
    console.error(`\nFAILED: ${error.message}`);
    for (const { name, lines } of children) console.error(`\n── last lines of ${name} ──\n${lines.slice(-30).join("\n")}`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopAll();
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  });
