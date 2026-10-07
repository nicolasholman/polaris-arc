#!/usr/bin/env node
// The backend end to end, on a local chain, with nothing live:
//
//   pnpm --filter @polaris/business e2e:local
//
//  1. starts a Hardhat node on 127.0.0.1:8610 and deploys every contract with
//     the testnet deploy script (MockAUSD and a local CRE forwarder standing in);
//  2. starts Polaris for Business on :3530 with the dev relayer adapter (a
//     local key held to the production relayer policy) and a fresh SQLite db;
//     Privy is forced off (POLARIS_DISABLE_PRIVY=1), so nothing touches the
//     live app whose keys sit in .env.local;
//  3. seeds the demo merchant with an API key and a webhook endpoint pointing
//     at a receiver on :3531 that verifies every delivery with polarispay-sdk;
//  4. with polarispay-sdk/server: creates a checkout session (and replays it
//     with the same Idempotency-Key), reads it as the hosted checkout does,
//     signs as a fresh buyer who holds no MON, and relays Pay now through
//     /api/relay; then a Pay in 4 session: a report through the mock forwarder
//     with hand-built facts (no CRE workflow, DON or Nansen runs here) opens the
//     buyer's credit line, the buyer signs PlanIntent + Permit, /api/relay opens
//     the plan; then the SDK's direct pay through /api/v1/relay/payments;
//  5. moves the clock a week, delivers a hand-built collections report through
//     the mock forwarder, and waits for the chain sync to turn it into
//     `installment.collected`.
//     The CRE evidence is elsewhere: workflows' e2e:local runs the real
//     workflow handlers, and `cre workflow simulate` runs them in the CLI;
//  6. checks every webhook arrived, verified, with the documented fields, that
//     the sessions read back as complete, and that the buyer sent nothing.
//
// Option: --keep (leave the node and server running afterwards).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  collectionsReceiverAbi,
  mockAUSDAbi,
  mockKeystoneForwarderAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
} from "@polarispay/contracts/abi";
import { APP_DIR, REPO_DIR, flag } from "./privy/lib.mjs";
import { seedMerchant } from "./lib/seed.mjs";

// Ports: the first free one in each range (E2E_*_PORT pins one).
let NODE_PORT = Number(process.env.E2E_NODE_PORT ?? 8610);
let APP_PORT = Number(process.env.E2E_APP_PORT ?? 3530);
let HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 3531);
let RPC = "";
let BASE = "";
const CONTRACTS_DIR = join(REPO_DIR, "packages", "contracts");
const SDK_DIR = join(REPO_DIR, "packages", "sdk");
const DEPLOYMENT = join(CONTRACTS_DIR, "deployments", "monad-local.json");
// Hardhat's well-known local test accounts (public; only ever valid on a local node).
const HARDHAT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];
const OWNER = privateKeyToAccount(HARDHAT_KEYS[0]); // deployer, registry owner, CRE simulation transmitter, MockAUSD minter
const RELAYER = privateKeyToAccount(HARDHAT_KEYS[1]); // the dev relayer adapter's key

const children = [];
const work = mkdtempSync(join(tmpdir(), "polaris-e2e-"));
const results = [];
let step = 0;

function log(msg) {
  console.log(msg);
}
function pass(what, detail = "") {
  step++;
  results.push(what);
  log(`  ${String(step).padStart(2)}. PASS  ${what}${detail ? `  ${detail}` : ""}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

async function until(what, fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: opts.quiet ? "ignore" : "inherit", shell: process.platform === "win32", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

function background(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
  const lines = [];
  const keep = (b) => {
    for (const line of b.toString().split(/\r?\n/)) if (line.trim()) lines.push(line);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
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

async function rpcReady() {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  return res.ok;
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  const taken = new Set();
  const pick = async (preferred, pinned, last, what) => {
    for (let port = preferred; port <= (pinned ? preferred : last); port++) {
      if (!taken.has(port) && (await portFree(port))) {
        taken.add(port);
        return port;
      }
    }
    throw new Error(`No free port for ${what} (tried ${preferred}${pinned ? "" : `-${last}`}).`);
  };
  NODE_PORT = await pick(NODE_PORT, Boolean(process.env.E2E_NODE_PORT), 8619, "the Hardhat node");
  APP_PORT = await pick(APP_PORT, Boolean(process.env.E2E_APP_PORT), 3539, "Polaris for Business");
  HOOK_PORT = await pick(HOOK_PORT, Boolean(process.env.E2E_HOOK_PORT), 3539, "the webhook receiver");
  RPC = `http://127.0.0.1:${NODE_PORT}`;
  BASE = `http://localhost:${APP_PORT}`;

  log("Polaris for Business, end to end on a local chain\n");

  // ── 1. chain ─────────────────────────────────────────────────────────────
  const hardhat = join(CONTRACTS_DIR, "node_modules", "hardhat", "internal", "cli", "bootstrap.js");
  background("hardhat node", process.execPath, [hardhat, "node", "--hostname", "127.0.0.1", "--port", String(NODE_PORT)], { cwd: CONTRACTS_DIR, shell: false });
  await until("the Hardhat node", rpcReady, { timeoutMs: 120_000 });
  await run(process.execPath, [hardhat, "compile", "--quiet"], { cwd: CONTRACTS_DIR, quiet: true, shell: false });
  await run(process.execPath, [hardhat, "run", "scripts/deploy-monad.js", "--network", "monadLocal"], {
    cwd: CONTRACTS_DIR,
    quiet: true,
    shell: false,
    env: { ...process.env, POLARIS_LOCAL_NODE_PORT: String(NODE_PORT), RELAYER_ADDRESS: RELAYER.address },
  });
  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const C = Object.fromEntries(Object.entries(deployment.contracts).map(([k, v]) => [k, getAddress(v.address)]));
  pass("contracts deployed on the local node", `(chain ${deployment.chainId}, relayer ${RELAYER.address} granted its roles)`);

  const chain = defineChain({ id: deployment.chainId, name: "local", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = createPublicClient({ chain, transport: http(RPC), pollingInterval: 200 });
  const owner = createWalletClient({ account: OWNER, chain, transport: http(RPC) });

  // ── 2. the SDK, built ────────────────────────────────────────────────────
  if (!existsSync(join(SDK_DIR, "dist", "esm", "server.js"))) {
    await run("pnpm", ["--filter", "polarispay-sdk", "build"], { cwd: REPO_DIR, quiet: true });
  }
  const sdkServer = await import(new URL(`file:///${join(SDK_DIR, "dist", "esm", "server.js").replace(/\\/g, "/")}`).href);

  // ── 3. the webhook receiver ──────────────────────────────────────────────
  const received = [];
  let webhookSecret = null;
  const hooks = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const event = sdkServer.verifyWebhook(raw, req.headers["polaris-signature"], webhookSecret);
        received.push({ event, headers: req.headers });
        res.writeHead(204).end();
      } catch (error) {
        received.push({ error: error.message });
        res.writeHead(400).end("bad signature");
      }
    });
  });
  await new Promise((r) => hooks.listen(HOOK_PORT, "127.0.0.1", r));

  // ── 4. the server ────────────────────────────────────────────────────────
  const dbUrl = `sqlite:${join(work, "polaris.db")}`;
  const pepper = "e2e-pepper";
  const serverEnv = {
    ...process.env,
    NODE_ENV: "development",
    POLARIS_DEPLOYMENT_FILE: DEPLOYMENT,
    POLARIS_RPC_URL: RPC,
    RELAYER_MODE: "local",
    RELAYER_PRIVATE_KEY: HARDHAT_KEYS[1],
    REGISTRY_ACTIVATOR: "local",
    REGISTRY_OWNER_PRIVATE_KEY: HARDHAT_KEYS[0],
    POLARIS_DB_URL: dbUrl,
    POLARIS_KEY_PEPPER: pepper,
    POLARIS_DISABLE_PRIVY: "1",
    POLARIS_WEBHOOK_ALLOW_PRIVATE: "1",
    POLARIS_CHECKOUT_ORIGIN: "http://localhost:3000",
    POLARIS_PUBLIC_URL: BASE,
    POLARIS_WORKERS: "1",
    PAY_IN_4_INTERVAL_SECONDS: "604800",
    CRON_SECRET: "e2e-cron-secret",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // The server imports @polarispay/underwriting's compiled core: build it if it is missing or stale.
  await run(process.execPath, [join(APP_DIR, "scripts", "ensure-deps.mjs")], { cwd: APP_DIR, quiet: true, shell: false });
  const next = join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
  background("next", process.execPath, [next, "dev", "--port", String(APP_PORT)], { cwd: APP_DIR, env: serverEnv, shell: false });
  const health = await until("Polaris for Business", async () => {
    const h = await api("/api/health");
    return h.status === 200 && h.body?.data?.ok ? h.body.data : null;
  }, { timeoutMs: 240_000, everyMs: 1000 });
  assert(health.relayer.address === RELAYER.address, "the server relays with the dev adapter's key");
  pass("Polaris for Business is up", `(relayer ${health.relayer.mode} ${health.relayer.address}, chain ${health.chain.id})`);

  // ── 5. the merchant ──────────────────────────────────────────────────────
  const seeded = await seedMerchant({ dbUrl, pepper, wallet: deployment.demo.merchant, name: deployment.demo.merchantName, webhookUrl: `http://127.0.0.1:${HOOK_PORT}/webhook`, registration: "active" });
  webhookSecret = seeded.webhookSecret;
  pass("merchant seeded with an sk_test_ key and a webhook endpoint", `(${seeded.merchant.publicId}, ${deployment.demo.merchant})`);

  const polaris = sdkServer.createPolarisServer({ secretKey: seeded.secretKey, baseUrl: BASE });

  // A buyer who has dollars and nothing else.
  const buyer = privateKeyToAccount(generatePrivateKey());
  await client.waitForTransactionReceipt({
    hash: await owner.writeContract({ address: C.Stablecoin, abi: mockAUSDAbi, functionName: "mint", args: [buyer.address, 1_000_000_000n] }),
  });
  const orderKey = (merchant, orderId) => keccak256(encodePacked(["address", "string"], [merchant, orderId]));
  const waitFor = (type, match = () => true) =>
    until(`the ${type} webhook`, () => received.find((r) => r.event?.type === type && match(r.event)), { timeoutMs: 60_000 });

  // ── 6. Pay now through a checkout session ────────────────────────────────
  const orderNow = `e2e-now-${Date.now()}`;
  const createNow = () =>
    polaris.checkout.sessions.create(
      { amount: "25.00", description: "Logo sketch", modes: ["now", "later"], successUrl: "http://localhost:3000/thanks?s={CHECKOUT_SESSION_ID}", orderId: orderNow, metadata: { e2e: "pay-now" } },
      { idempotencyKey: orderNow },
    );
  const s1 = await createNow();
  const s1again = await createNow();
  assert(s1again.id === s1.id, "an Idempotency-Key replay returns the same session");
  pass("checkout.sessions.create via polarispay-sdk, replayed with the same Idempotency-Key", `(${s1.id})`);

  const pub1 = (await api(`/api/public/sessions/${s1.id}`)).body.data;
  assert(pub1.chain.amountUnits === "25000000" && pub1.chain.orderId === orderNow, "the public session carries the on-chain terms");
  assert(!("metadata" in pub1), "the public session has no metadata");
  const domain = { ...pub1.chain.stablecoinDomain, chainId: pub1.chain.chainId, verifyingContract: pub1.chain.contracts.stablecoin };
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 900);
  const rwa = await buyer.signTypedData({
    domain,
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from: buyer.address, to: pub1.chain.contracts.payments, value: 25_000_000n, validAfter: 0n, validBefore, nonce: pub1.chain.orderKey },
  });
  const paid = await api("/api/relay", { method: "POST", body: JSON.stringify({ type: "pay", sessionId: s1.id, buyer: buyer.address, validAfter: "0", validBefore: String(validBefore), signature: rwa }) });
  assert(paid.status === 200 && paid.body.data.status === "confirmed", `relay pay: ${JSON.stringify(paid.body)}`);
  const payTx = await client.getTransaction({ hash: paid.body.data.txHash });
  const payReceipt = await client.getTransactionReceipt({ hash: paid.body.data.txHash });
  assert(getAddress(payTx.from) === RELAYER.address && getAddress(payTx.to) === C.PolarisCheckout, "the relayer sent PolarisCheckout.pay");
  pass("Pay now relayed through /api/relay", `(gas ${payReceipt.gasUsed} of limit ${payTx.gas}, ${paid.body.data.txHash.slice(0, 12)}…)`);

  const payEvent = await waitFor("payment.succeeded", (e) => e.data.sessionId === s1.id);
  assert(payEvent.event.data.amount === "25.00" && payEvent.event.data.orderId === orderNow && payEvent.event.data.metadata.e2e === "pay-now", "payment.succeeded carries the order");
  assert(payEvent.event.data.paymentId === orderKey(deployment.demo.merchant, orderNow), "paymentId is the order key");
  pass("payment.succeeded webhook arrived, verified by polarispay-sdk", `(${payEvent.event.id})`);
  const s1read = await polaris.checkout.sessions.retrieve(s1.id);
  assert(s1read.status === "complete" && s1read.paymentStatus === "paid" && s1read.payment.txHash === paid.body.data.txHash, "the session reads back complete");
  pass("checkout.sessions.retrieve shows the session complete, with the transaction");

  // ── 7. Pay in 4 ──────────────────────────────────────────────────────────
  // These reports are built by hand and pushed through the local MockKeystoneForwarder,
  // which checks no signatures: no CRE workflow or DON runs here. The workflows' own
  // round trip is workflows/ e2e:local; their real runs on Monad are workflows/evidence/.
  const { encodeRawReport, encodeUnderwritingReport, encodeCollectionsReport, WORKFLOW_NAMES, ACTION } = createRequire(join(CONTRACTS_DIR, "package.json"))("./lib/cre.js");
  const block = await client.getBlock();
  const underwriting = encodeUnderwritingReport([
    {
      user: buyer.address,
      linkedWallet: privateKeyToAccount(generatePrivateKey()).address,
      facts: { walletAgeDays: 730, txCount: 1200, stableBalance: 2_500_000_000n, defiTenureDays: 400, priorLiquidations: 0, relatedWallets: 1, exchangeFunded: true, observedAt: block.timestamp },
    },
  ]);
  const report = async (receiver, body, workflowName) => {
    const raw = encodeRawReport({ body, workflowName, workflowOwner: OWNER.address, executionId: keccak256(stringToHex(`${Date.now()}-${Math.random()}`)), timestamp: Number((await client.getBlock()).timestamp) });
    const hash = await owner.writeContract({ address: C.MockKeystoneForwarder, abi: mockKeystoneForwarderAbi, functionName: "report", args: [receiver, raw, "0x", []] });
    const r = await client.waitForTransactionReceipt({ hash });
    const [processed] = parseEventLogs({ abi: mockKeystoneForwarderAbi, logs: r.logs, eventName: "ReportProcessed" });
    assert(processed?.args.result, "the receiver accepted the hand-built mock forwarder report");
    return r;
  };
  await report(C.UnderwritingReceiver, underwriting, WORKFLOW_NAMES.UNDERWRITING);
  pass("mock forwarder report (hand-built facts, no CRE workflow) opened the buyer's credit line");

  const orderPlan = `e2e-plan-${Date.now()}`;
  const s2 = await polaris.checkout.sessions.create(
    { amount: "200.00", description: "Brand identity package", modes: ["later"], successUrl: "http://localhost:3000/thanks", orderId: orderPlan },
    { idempotencyKey: orderPlan },
  );
  const pub2 = (await api(`/api/public/sessions/${s2.id}`)).body.data;
  assert(pub2.payIn4?.available, `Pay in 4 offered: ${JSON.stringify(pub2.payIn4)}`);
  assert(pub2.payIn4.total === "201.534246", "$200 is 4 × $50.38 with $1.53 interest");
  const interval = BigInt(pub2.payIn4.intervalSeconds);
  const quote = await client.readContract({ address: C.PolarisCheckout, abi: polarisCheckoutAbi, functionName: "quotePlan", args: [buyer.address, 200_000_000n, 4, interval] });
  const checkoutNonce = await client.readContract({ address: C.PolarisCheckout, abi: polarisCheckoutAbi, functionName: "nonces", args: [buyer.address] });
  const tokenNonce = await client.readContract({ address: C.Stablecoin, abi: mockAUSDAbi, functionName: "nonces", args: [buyer.address] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const intent = { buyer: buyer.address, merchant: pub2.chain.merchant, principal: 200_000_000n, installments: 4, interval, orderId: pub2.chain.orderId, nonce: checkoutNonce, deadline: now + 600n };
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
  const permitSig = await buyer.signTypedData({
    domain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: buyer.address, spender: pub2.chain.contracts.loanEngine, value: quote.permitValue, nonce: tokenNonce, deadline: now + 1800n },
  });
  const opened = await api("/api/relay", {
    method: "POST",
    body: JSON.stringify({
      type: "openPlan",
      sessionId: s2.id,
      intent: { buyer: buyer.address, principal: "200000000", installments: "4", interval: String(interval), nonce: String(checkoutNonce), deadline: String(intent.deadline) },
      signature: intentSig,
      permit: { value: String(quote.permitValue), deadline: String(now + 1800n), signature: permitSig },
    }),
  });
  assert(opened.status === 200 && opened.body.data.status === "confirmed" && opened.body.data.planId, `relay openPlan: ${JSON.stringify(opened.body)}`);
  const loanId = BigInt(opened.body.data.planId);
  const planReceipt = await client.getTransactionReceipt({ hash: opened.body.data.txHash });
  pass("Pay in 4 opened through /api/relay (PlanIntent + Permit)", `(plan #${loanId}, gas ${planReceipt.gasUsed})`);

  const planEvent = await waitFor("plan.opened", (e) => e.data.sessionId === s2.id);
  assert(planEvent.event.data.schedule.length === 4 && planEvent.event.data.total === "201.534246", "plan.opened carries the schedule");
  pass("plan.opened webhook arrived with the four-instalment schedule", `(${planEvent.event.data.schedule.map((s) => s.amount).join(", ")})`);
  const s2read = await polaris.checkout.sessions.retrieve(s2.id);
  assert(s2read.status === "complete" && s2read.payment.planId === String(loanId), "the Pay in 4 session reads back complete");

  // ── 8. Direct pay (polarispay-sdk pay() → /api/v1/relay/payments) ─────────
  const orderDirect = `e2e-direct-${Date.now()}`;
  const nonceDirect = orderKey(deployment.demo.merchant, orderDirect);
  const vb = BigInt(Math.floor(Date.now() / 1000) + 900);
  const directSig = await buyer.signTypedData({
    domain,
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from: buyer.address, to: C.PolarisPayments, value: 5_000_000n, validAfter: 0n, validBefore: vb, nonce: nonceDirect },
  });
  const direct = await api("/api/v1/relay/payments", {
    method: "POST",
    headers: { authorization: `Bearer ${seeded.publishableKey}`, "polaris-client": "polarispay-sdk/0.3.0" },
    body: JSON.stringify({
      type: "payWithAuthorization",
      chainId: deployment.chainId,
      contract: C.PolarisPayments,
      payer: buyer.address,
      merchant: deployment.demo.merchant,
      amount: "5000000",
      orderId: orderDirect,
      validAfter: "0",
      validBefore: String(vb),
      nonce: nonceDirect,
      signature: directSig,
    }),
  });
  assert(direct.status === 201 && direct.body.data.paymentId === nonceDirect, `direct pay: ${JSON.stringify(direct.body)}`);
  await waitFor("payment.succeeded", (e) => e.data.orderId === orderDirect);
  pass("SDK direct pay through /api/v1/relay/payments (pk_test_ key), payment.succeeded delivered");

  // ── 9. a hand-built collections report collects instalment 1; the chain sync sends the webhook ──
  await client.request({ method: "evm_increaseTime", params: [Number(interval) + 1] });
  await client.request({ method: "evm_mine", params: [] });
  const tasks = [{ action: ACTION.COLLECT_INSTALLMENT, id: loanId }];
  const ready = await client.readContract({ address: C.CollectionsReceiver, abi: collectionsReceiverAbi, functionName: "checkTasks", args: [tasks] });
  assert(ready[0], "instalment 1 is due");
  await report(C.CollectionsReceiver, encodeCollectionsReport(tasks), WORKFLOW_NAMES.COLLECTIONS);
  const collected = await waitFor("installment.collected", (e) => e.data.planId === String(loanId));
  assert(collected.event.data.installment === 1 && collected.event.data.amount === "50.383562", "instalment 1 of 4, $50.38");
  const loan = await client.readContract({ address: C.PolarisLoanEngine, abi: polarisLoanEngineAbi, functionName: "getLoan", args: [loanId] });
  assert(loan.installmentsPaid === 1, "the loan engine agrees");
  pass("mock forwarder collections report (hand-built task) collected instalment 1; installment.collected arrived from the chain sync", `(remaining $${collected.event.data.remaining})`);

  // ── 10. checks ───────────────────────────────────────────────────────────
  const bad = received.filter((r) => r.error);
  assert(bad.length === 0, `every delivery verified (${bad.map((b) => b.error).join("; ")})`);
  const buyerMon = await client.getBalance({ address: buyer.address });
  const buyerTxs = await client.getTransactionCount({ address: buyer.address });
  assert(buyerMon === 0n && buyerTxs === 0, "the buyer held no MON and sent no transaction");
  pass("the buyer never held MON or sent a transaction; every webhook verified", `(${received.length} deliveries: ${[...new Set(received.map((r) => r.event.type))].join(", ")})`);

  hooks.close();
  log(`\nAll ${results.length} checks passed.`);
}

function stopAll() {
  for (const { child } of children) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch {
      // gone
    }
  }
}

main()
  .catch((error) => {
    console.error(`\nFAILED: ${error.message}`);
    for (const { name, lines } of children) {
      console.error(`\n── last lines of ${name} ──\n${lines.slice(-40).join("\n")}`);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    if (flag("keep") && process.exitCode !== 1) {
      console.log(`\n--keep: node on ${RPC}, server on ${BASE}. Ctrl+C to stop.`);
      return;
    }
    stopAll();
    setTimeout(() => {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        // Windows may still hold the database for a moment
      }
      process.exit(process.exitCode ?? 0);
    }, 1500);
  });
