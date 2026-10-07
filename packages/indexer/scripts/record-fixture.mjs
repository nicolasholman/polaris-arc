#!/usr/bin/env node
/**
 * Record a real event log for the indexer's replay test.
 *
 *   node scripts/record-fixture.mjs          # needs packages/contracts installed (the workspace)
 *
 * Starts a Hardhat node on 127.0.0.1:3540 (POLARIS_FIXTURE_PORT), deploys the
 * whole contract layer with the same script as testnet, runs the contracts'
 * own end-to-end flows (scripts/e2e-monad-local.js) and then
 * scripts/fixture-scenarios.cjs for the flows it does not cover, and writes
 * test/fixtures/local-chain.json:
 *
 *   - every log the indexer would see, decoded, with its block, timestamp,
 *     log index, transaction hash, sender and target;
 *   - the contracts' own view of the end state (loans, subscriptions, credit
 *     lines, merchant balances, links), read with eth_call.
 *
 * test/replay.test.ts replays the log through the real handlers and checks
 * the indexed state against those views. Runs on Windows or Linux.
 *
 * Options (for scripts/live.sh, which indexes the same chain over RPC):
 *   --out <file>    write the fixture there instead
 *   --keep-node     leave the Hardhat node running and print its pid
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CONTRACTS = resolve(ROOT, "../contracts");
const PORT = Number(process.env.POLARIS_FIXTURE_PORT || 3540);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(option("--out") ?? join(ROOT, "test", "fixtures", "local-chain.json"));
const KEEP_NODE = flag("--keep-node");

const require = createRequire(join(CONTRACTS, "package.json"));
const { JsonRpcProvider, Interface, Contract } = require("ethers");
const HARDHAT = join(dirname(require.resolve("hardhat/package.json")), "internal", "cli", "bootstrap.js");

/** Contracts whose logs the indexer reads, by deployment name, with their ABI file. */
const SOURCES = {
  ScoreManager: "ScoreManager",
  PolarisLoanEngine: "PolarisLoanEngine",
  PolarisPayments: "PolarisPayments",
  MerchantRegistry: "MerchantRegistry",
  CollateralVault: "CollateralVault",
  BatchSettlement: "BatchSettlement",
  PolarisSend: "PolarisSend",
  PolarisCheckout: "PolarisCheckout",
  CollectionsReceiver: "CollectionsReceiver",
  UnderwritingReceiver: "UnderwritingReceiver",
  MockKeystoneForwarder: "MockKeystoneForwarder",
  Stablecoin: "IAUSD",
};

function abi(name) {
  const raw = JSON.parse(readFileSync(join(CONTRACTS, "abi", `${name}.json`), "utf8"));
  return Array.isArray(raw) ? raw : raw.abi;
}

async function rpcReady(url) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function hardhat(args, env = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [HARDHAT, ...args], {
      cwd: CONTRACTS,
      stdio: "inherit",
      env: { ...process.env, POLARIS_LOCAL_NODE_PORT: String(PORT), ...env },
    });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`hardhat ${args.join(" ")} exited ${code}`))));
  });
}

/** JSON-safe: bigints as decimal strings, everything else as is. */
function plain(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

async function dump(url) {
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const d = JSON.parse(readFileSync(join(CONTRACTS, "deployments", "monad-local.json"), "utf8"));
  const byAddress = new Map();
  for (const [name, abiName] of Object.entries(SOURCES)) {
    const address = d.contracts[name]?.address?.toLowerCase();
    if (!address) throw new Error(`monad-local.json has no ${name}`);
    byAddress.set(address, { name, iface: new Interface(abi(abiName)) });
  }

  const latest = await provider.getBlockNumber();
  const logs = await provider.getLogs({ fromBlock: 0, toBlock: latest });
  const blocks = new Map();
  const txs = new Map();
  const events = [];
  for (const log of logs) {
    const source = byAddress.get(log.address.toLowerCase());
    if (!source) continue;
    let parsed;
    try {
      parsed = source.iface.parseLog(log);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    if (!blocks.has(log.blockNumber)) blocks.set(log.blockNumber, (await provider.getBlock(log.blockNumber)).timestamp);
    if (!txs.has(log.transactionHash)) {
      const t = await provider.getTransaction(log.transactionHash);
      txs.set(log.transactionHash, { from: t.from.toLowerCase(), to: t.to?.toLowerCase() ?? null });
    }
    const params = {};
    parsed.fragment.inputs.forEach((input, i) => {
      const v = parsed.args[i];
      params[input.name] = typeof v === "string" && input.type === "address" ? v.toLowerCase() : v;
    });
    events.push({
      contract: source.name,
      event: parsed.name,
      srcAddress: log.address.toLowerCase(),
      blockNumber: log.blockNumber,
      timestamp: blocks.get(log.blockNumber),
      logIndex: log.index,
      txHash: log.transactionHash.toLowerCase(),
      txFrom: txs.get(log.transactionHash).from,
      txTo: txs.get(log.transactionHash).to,
      params: plain(params),
    });
  }

  // The contracts' own view of the end state.
  const at = (name, abiName = SOURCES[name]) => new Contract(d.contracts[name].address, abi(abiName), provider);
  const engine = at("PolarisLoanEngine");
  const payments = at("PolarisPayments");
  const scores = at("ScoreManager");
  const vault = at("CollateralVault");
  const token = at("Stablecoin");
  const registry = at("MerchantRegistry");
  const send = at("PolarisSend");
  const of = (contract, event, key) => [...new Set(events.filter((e) => e.contract === contract && e.event === event).map((e) => e.params[key]))];

  const loans = {};
  for (const id of of("PolarisLoanEngine", "LoanCreated", "loanId")) {
    const l = await engine.getLoan(id);
    loans[id] = plain({
      status: Number(l.status),
      installmentsPaid: Number(l.installmentsPaid),
      totalRepaid: l.totalRepaid,
      totalOwed: l.totalOwed,
      outstanding: await engine.outstandingOf(id),
      installmentDue: await engine.isInstallmentDue(id),
      liquidatable: await engine.checkLiquidatable(id),
    });
  }
  const subscriptions = {};
  for (const id of of("PolarisPayments", "Subscribed", "subId")) {
    const s = await payments.getSubscription(id);
    subscriptions[id] = plain({
      status: Number(s.status),
      nextChargeAt: Number(s.nextChargeAt),
      periodsCharged: Number(s.periodsCharged),
      missedCharges: Number(s.missedCharges),
    });
  }
  const buyers = {};
  const people = new Set([
    ...of("PolarisLoanEngine", "LoanCreated", "borrower"),
    ...of("PolarisPayments", "PaymentMade", "payer"),
    ...of("PolarisPayments", "Subscribed", "subscriber"),
    ...of("ScoreManager", "ScoreChanged", "user"),
  ]);
  for (const u of people) {
    const p = await scores.profileOf(u);
    buyers[u] = plain({
      score: Number(p.score),
      declined: p.declined,
      underwritten: p.underwritten,
      creditLimit: await scores.creditLimitOf(u),
      activeDebt: await engine.activeDebtOf(u),
      collateral: await vault.lockedOf(u),
    });
  }
  const merchants = {};
  const merchantSet = new Set([
    ...of("MerchantRegistry", "MerchantRegistered", "merchant"),
    ...of("PolarisPayments", "PaymentMade", "merchant"),
    ...of("PolarisPayments", "PlanCreated", "merchant"),
    ...of("PolarisLoanEngine", "LoanCreated", "merchant"),
  ]);
  for (const m of merchantSet) {
    const r = await registry.merchantOf(m);
    merchants[m] = plain({
      balance: await token.balanceOf(m),
      registered: r.registeredAt !== 0n,
      active: r.active,
      payoutAddress: r.payoutAddress.toLowerCase(),
      maxOrderValue: r.maxOrderValue,
    });
  }
  const sends = {};
  for (const k of of("PolarisSend", "Sent", "linkKey")) {
    sends[k] = { open: (await send.linkOf(k)).sender !== "0x0000000000000000000000000000000000000000" };
  }

  return {
    note: "Recorded by scripts/record-fixture.mjs from a local Hardhat chain. Do not edit.",
    chainId: d.chainId,
    graceSeconds: d.config.graceSeconds,
    contracts: Object.fromEntries(Object.keys(SOURCES).map((n) => [n, d.contracts[n].address.toLowerCase()])),
    events,
    expected: { loans, subscriptions, buyers, merchants, sends },
  };
}

async function main() {
  const url = `http://127.0.0.1:${PORT}`;
  if (await rpcReady(url)) throw new Error(`Something already answers on port ${PORT}; set POLARIS_FIXTURE_PORT (3540-3549).`);
  // Compile before the node starts: a node started without artifacts cannot
  // name custom errors ("unrecognized custom error"), and the end-to-end
  // flows check reverts by name. A fresh checkout has no artifacts yet.
  await hardhat(["compile", "--quiet"]);
  const node = spawn(process.execPath, [HARDHAT, "node", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: CONTRACTS,
    stdio: ["ignore", "ignore", "inherit"],
    detached: KEEP_NODE,
  });
  let ok = false;
  try {
    const started = Date.now();
    while (!(await rpcReady(url))) {
      if (node.exitCode !== null) throw new Error(`hardhat node exited ${node.exitCode}`);
      if (Date.now() - started > 120_000) throw new Error("hardhat node did not start within 2 minutes");
      await new Promise((r) => setTimeout(r, 500));
    }
    await hardhat(["run", "scripts/deploy-monad.js", "--network", "monadLocal"]);
    await hardhat(["run", "scripts/e2e-monad-local.js", "--network", "monadLocal"]);
    await hardhat(["run", join(ROOT, "scripts", "fixture-scenarios.cjs"), "--network", "monadLocal"], { POLARIS_CONTRACTS_DIR: CONTRACTS });
    const fixture = await dump(url);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
    const kinds = new Set(fixture.events.map((e) => `${e.contract}.${e.event}`));
    console.log(`\nWrote ${OUT}: ${fixture.events.length} logs, ${kinds.size} kinds of event, ${Object.keys(fixture.expected.loans).length} loans.`);
    ok = true;
    if (KEEP_NODE) {
      node.unref();
      console.log(`Hardhat node left running on ${url} (pid ${node.pid}).`);
    }
  } finally {
    if (!KEEP_NODE || !ok) node.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

