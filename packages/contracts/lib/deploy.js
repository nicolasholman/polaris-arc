/**
 * Deploy and wire the whole Polaris contract layer on Arc, in dependency order.
 *
 * Used by scripts/deploy.js (Arc testnet, Arc mainnet, or a local Hardhat
 * node) and by test/integration/Deploy.test.js, which runs it in-process and
 * checks every role it grants. It returns a plain record; the script decides
 * where to write it.
 *
 * Every transaction goes through lib/tx.js: an estimated gas limit plus 15%,
 * priced at or above Arc's 20 gwei fee floor. Gas is paid in USDC.
 */

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getAddress, ZeroAddress, Wallet } = require("ethers");

const tx = require("./tx");
const { TYPES, DOMAIN_NAMES, USDC_DOMAIN, readDomain, domainJson } = require("./eip712");
const { ACTION, REPORT_KIND, TASKS_TYPE, UNDERWRITINGS_TYPE, GUARD_REASON, GUARD_OVERRIDE, guardThresholds } = require("./keeper");

const USD = (n) => BigInt(Math.round(Number(n) * 1e6));

/**
 * @typedef {object} DeployConfig
 * @property {import("./networks").ARC_TESTNET} network   the Arc network (lib/networks.js)
 * @property {"arc"|"mock"} tokenMode   Circle's USDC/EURC on Arc, or fresh MockUSDC/MockEURC (local only)
 * @property {string} treasury          protocol fees go here
 * @property {string} keeper            the keeper EOA: the only writer to the receivers
 * @property {string} [relayer]         the relayer EOA: operator on Payments and the registry, settler on BatchSettlement
 * @property {number} graceSeconds      LoanEngine grace period
 * @property {number} minInterval       LoanEngine minimum instalment interval
 * @property {number} minPeriod         PolarisPayments minimum subscription period
 * @property {{minFreeCash?: bigint, maxBadDebtBps?: number, minOriginated?: bigint}} [guard] CreditGuard thresholds
 * @property {import("ethers").Wallet} demoMerchant  signs its own registration
 * @property {bigint} poolSeed          USDC base units to fund the credit pool with (at most what the deployer holds)
 * @property {bigint} [merchantCap]     the demo merchant's max order value
 */

async function deployPolaris(hre, cfg, log = () => {}) {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  if (!cfg.keeper || getAddress(cfg.keeper) === ZeroAddress) throw new Error("A keeper address is required.");
  if (getAddress(cfg.keeper) === deployer.address) {
    throw new Error("The keeper must be its own key, not the deployer: it is the only writer of credit facts.");
  }
  if (cfg.tokenMode === "mock" && cfg.network.key !== "local") throw new Error("MockUSDC is for a local node only.");

  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== cfg.network.chainId) {
    throw new Error(`Connected to chain ${net.chainId}, but NETWORK=${cfg.network.key} is chain ${cfg.network.chainId}.`);
  }
  const record = {
    network: cfg.network.key,
    chainId: Number(net.chainId),
    chainName: cfg.network.name,
    rpcUrl: cfg.network.rpcUrl,
    explorerUrl: cfg.network.explorerUrl,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    ...sourceCommitOf(log),
    circle: cfg.network.circle,
    contracts: {},
    config: {},
    roles: {},
    keeper: {},
    demo: {},
    gas: { totalUsed: "0", note: "Arc gas is paid in USDC; see totalCostUsdc." },
  };
  const addresses = {};
  let gasUsed = 0n;
  let gasCost = 0n;
  const tally = (receipt) => {
    gasUsed += receipt.gasUsed;
    gasCost += receipt.gasUsed * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  };

  async function deployContract(name, args, label = name) {
    const factory = await ethers.getContractFactory(name, deployer);
    const d = await tx.deploy(factory, args);
    tally(d.receipt);
    record.contracts[label] = {
      address: d.address,
      blockNumber: d.receipt.blockNumber,
      txHash: d.receipt.hash,
      gasUsed: d.receipt.gasUsed.toString(),
      contract: name,
      abi: `abi/${name}.json`,
      args: jsonSafe(args),
    };
    addresses[label] = d.address;
    log(`  ${label.padEnd(22)} ${d.address}  (block ${d.receipt.blockNumber}, gas ${d.receipt.gasUsed})`);
    return d.contract;
  }

  const send = async (contract, method, args) => {
    const r = await tx.send(contract, method, args);
    tally(r);
    return r;
  };

  // ------------------------------------------------------------ tokens
  log("Stablecoins");
  let usdc;
  let eurc = null;
  if (cfg.tokenMode === "mock") {
    usdc = await deployContract("MockUSDC", ["USDC"], "USDC");
    eurc = await deployContract("MockUSDC", ["EURC"], "EURC");
    record.contracts.USDC.kind = "MockUSDC (local only)";
    record.contracts.EURC.kind = "MockUSDC named EURC (local only)";
  } else {
    usdc = await useCircleToken(ethers, deployer, cfg.network.circle.usdc, "USDC", record, addresses, log);
    if (cfg.network.circle.eurc) {
      eurc = await useCircleToken(ethers, deployer, cfg.network.circle.eurc, "EURC", record, addresses, log);
    }
  }

  // -------------------------------------------------------------- core
  log("Core");
  const scores = await deployContract("ScoreManager", [deployer.address]);
  const engine = await deployContract("PolarisLoanEngine", [
    deployer.address,
    addresses.USDC,
    addresses.ScoreManager,
    cfg.treasury,
    cfg.graceSeconds,
    cfg.minInterval,
  ]);
  const payments = await deployContract("PolarisPayments", [deployer.address, addresses.USDC, cfg.treasury, cfg.minPeriod]);
  const registry = await deployContract("MerchantRegistry", [deployer.address]);
  const vault = await deployContract("CollateralVault", [deployer.address, addresses.USDC]);
  const batch = await deployContract("BatchSettlement", [deployer.address, addresses.USDC]);
  await deployContract("PolarisSend", [addresses.USDC]);
  if (eurc) await deployContract("PolarisSend", [addresses.EURC], "PolarisSendEURC");
  await deployContract("PolarisSplit", [addresses.USDC]);
  const checkout = await deployContract("PolarisCheckout", [
    deployer.address,
    addresses.PolarisLoanEngine,
    addresses.PolarisPayments,
    addresses.ScoreManager,
  ]);

  // ------------------------------------------------------------ keeper
  log("Keeper and credit guard");
  await deployContract("CollectionsReceiver", [cfg.keeper, addresses.PolarisLoanEngine, addresses.PolarisPayments]);
  await deployContract("UnderwritingReceiver", [cfg.keeper, addresses.ScoreManager]);
  const thresholds = guardThresholds(cfg.guard ?? {});
  await deployContract("CreditGuard", [deployer.address, addresses.PolarisLoanEngine, thresholds]);

  // -------------------------------------------------------------- CCIP
  // Pay a Polaris link (or a plan) from another chain: CCTP moves the USDC,
  // Chainlink CCIP carries the instruction to PolarisCCIPReceiver (ccip/, built
  // with Foundry because @chainlink/contracts-ccip needs remappings).
  if (cfg.network.ccip) {
    log("Chainlink CCIP");
    const art = foundryArtifact("PolarisCCIPReceiver");
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
    const d = await tx.deploy(factory, [cfg.network.ccip.router, addresses.USDC, addresses.PolarisPayments, addresses.PolarisLoanEngine, deployer.address]);
    tally(d.receipt);
    addresses.PolarisCCIPReceiver = d.address;
    record.contracts.PolarisCCIPReceiver = {
      address: d.address,
      blockNumber: d.receipt.blockNumber,
      txHash: d.receipt.hash,
      gasUsed: d.receipt.gasUsed.toString(),
      contract: "PolarisCCIPReceiver",
      abi: "abi/PolarisCCIPReceiver.json",
      args: jsonSafe([cfg.network.ccip.router, addresses.USDC, addresses.PolarisPayments, addresses.PolarisLoanEngine, deployer.address]),
      build: "foundry (ccip/)",
    };
    log(`  PolarisCCIPReceiver    ${d.address}  (router ${cfg.network.ccip.router}; senders are allowlisted after they deploy: scripts/ccip-allow-sender.js)`);
  }

  // ------------------------------------------------------------ wiring
  log("Roles");
  await send(scores, "setWriter", [addresses.PolarisLoanEngine, true]);
  await send(scores, "setUnderwriter", [addresses.UnderwritingReceiver, true]);
  await send(scores, "setCollateralVault", [addresses.CollateralVault]);
  // A fresh passkey account costs nothing, so no unsecured line opens without
  // a keeper review (ScoreManager.requireUnderwriting), and no review opens
  // one without a history behind it (ScoreManager.isThinFile).
  await send(scores, "setRequireUnderwriting", [true]);
  await send(vault, "setLoanEngine", [addresses.PolarisLoanEngine]);
  await send(vault, "setSeizer", [addresses.PolarisLoanEngine, true]);
  await send(engine, "setCollateralVault", [addresses.CollateralVault]);
  await send(engine, "setMerchantRegistry", [addresses.MerchantRegistry]);
  await send(engine, "setOriginator", [addresses.PolarisCheckout, true]);
  await send(payments, "setCheckout", [addresses.PolarisCheckout]);
  await send(checkout, "setCreditGuardian", [addresses.CreditGuard]);
  // Where Chainlink's USDC / USD feed runs (Arc mainnet), the guard also checks the peg:
  // below $0.98, or an answer older than 26 h (the feed's heartbeat is 24 h), pauses new plans.
  if (cfg.network.feeds?.usdcUsd) {
    const guard = await ethers.getContractAt("CreditGuard", addresses.CreditGuard, deployer);
    await send(guard, "setPriceCheck", [cfg.network.feeds.usdcUsd, 98_000_000n, 26 * 3600]);
    log(`  CreditGuard: USDC peg on Chainlink USDC / USD ${cfg.network.feeds.usdcUsd} (pause below $0.98 or older than 26 h)`);
  }
  log("  ScoreManager: writer = LoanEngine, underwriter = UnderwritingReceiver, requireUnderwriting");
  log("  LoanEngine: originator = PolarisCheckout (only), vault, registry");
  log("  PolarisPayments: checkout = PolarisCheckout");
  log(
    `  PolarisCheckout: credit guard = CreditGuard (pause below $${Number(thresholds.minFreeCash) / 1e6} free cash, ` +
      `bad debt > ${thresholds.maxBadDebtBps / 100}% once $${Number(thresholds.minOriginated) / 1e6} is lent)`
  );
  log(`  receivers: keeper = ${cfg.keeper}`);

  if (cfg.relayer) {
    await send(payments, "setOperator", [cfg.relayer, true]);
    await send(registry, "setOperator", [cfg.relayer, true]);
    await send(batch, "setSettler", [cfg.relayer, true]);
    log(`  relayer ${cfg.relayer}: PolarisPayments operator, MerchantRegistry operator, BatchSettlement settler`);
  }

  // --------------------------------------------------------- demo data
  log("Demo merchant");
  const merchant = cfg.demoMerchant.connect(ethers.provider);
  const regDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
  const regMessage = {
    merchant: merchant.address,
    name: "Halcyon Studio",
    payoutAddress: merchant.address,
    metadataURI: "https://polaris.arc/demo/merchant.json",
    nonce: await registry.nonces(merchant.address),
    deadline: regDeadline,
  };
  const regSig = await merchant.signTypedData(await readDomain(registry), { Registration: TYPES.MerchantRegistry.Registration }, regMessage);
  await send(registry, "registerFor", [regMessage.merchant, regMessage.name, regMessage.payoutAddress, regMessage.metadataURI, regDeadline, regSig]);
  await send(registry, "setActive", [merchant.address, true]);
  const cap = cfg.merchantCap ?? USD(1_000);
  await send(registry, "setMaxOrderValue", [merchant.address, cap]);
  log(`  ${merchant.address} registered by its own signature, active, cap $${Number(cap) / 1e6}`);

  const monthly = BigInt(30 * 24 * 3600);
  const planMonthly = await createPlan(payments, merchant.address, USD(9.99), monthly, "Studio Pro, monthly", tally);
  const planFast = await createPlan(payments, merchant.address, USD(1), BigInt(cfg.minPeriod), "Demo, every period", tally);
  log(`  subscription plans #${planMonthly} ($9.99 / 30 days) and #${planFast} ($1 / ${cfg.minPeriod}s)`);
  record.demo = {
    merchant: merchant.address,
    merchantName: regMessage.name,
    subscriptionPlans: [
      { planId: planMonthly.toString(), name: "Studio Pro, monthly", pricePerPeriod: USD(9.99).toString(), periodSeconds: monthly.toString() },
      { planId: planFast.toString(), name: "Demo, every period", pricePerPeriod: USD(1).toString(), periodSeconds: String(cfg.minPeriod) },
    ],
  };

  // -------------------------------------------------------------- pool
  log("Credit pool");
  const held = await usdc.balanceOf(deployer.address);
  // Keep 1 USDC of the deployer's balance for gas: on Arc the ERC-20 balance
  // and the gas balance are the same money.
  const spendable = held > USD(1) ? held - USD(1) : 0n;
  const seed = spendable < cfg.poolSeed ? spendable : cfg.poolSeed;
  if (seed > 0n) {
    await send(usdc, "approve", [addresses.PolarisLoanEngine, seed]);
    await send(engine, "fund", [seed]);
    log(`  funded ${ethers.formatUnits(seed, 6)} USDC`);
  } else {
    log("  NOT funded: the deployer has no USDC to spare. Pay in 4 stays paused (CreditGuard: low cash) until the pool is funded.");
  }
  record.demo.poolSeeded = seed.toString();
  record.demo.poolTarget = cfg.poolSeed.toString();

  // ------------------------------------------------------------ record
  record.config = {
    tokenMode: cfg.tokenMode,
    treasury: cfg.treasury,
    graceSeconds: cfg.graceSeconds,
    minInterval: cfg.minInterval,
    minPeriod: cfg.minPeriod,
    feeBps: Number(await payments.feeBps()),
    interestRateBps: Number(await engine.INTEREST_RATE_BPS()),
    requireUnderwriting: await scores.requireUnderwriting(),
    guard: { minFreeCash: thresholds.minFreeCash.toString(), maxBadDebtBps: thresholds.maxBadDebtBps, minOriginated: thresholds.minOriginated.toString() },
    caps: {
      sendMaxAmount: (await (await ethers.getContractAt("PolarisSend", addresses.PolarisSend)).MAX_AMOUNT()).toString(),
      vaultMaxLockedPerUser: (await vault.maxLockedPerUser()).toString(),
      merchantMaxOrderValue: cap.toString(),
      registryDefaultMaxOrderValue: (await registry.DEFAULT_MAX_ORDER_VALUE()).toString(),
      maxCreditLine: "1000000000",
    },
  };
  record.roles = {
    owner: deployer.address,
    keeper: cfg.keeper,
    relayer: cfg.relayer ?? null,
    loanEngineOriginators: [addresses.PolarisCheckout],
    paymentsCheckout: addresses.PolarisCheckout,
    scoreWriters: [addresses.PolarisLoanEngine],
    scoreUnderwriters: [addresses.UnderwritingReceiver],
    vaultSeizers: [addresses.PolarisLoanEngine],
    creditGuardian: addresses.CreditGuard,
  };
  record.keeper = {
    address: cfg.keeper,
    collections: {
      receiver: addresses.CollectionsReceiver,
      report: `abi.encode(uint8 kind = ${REPORT_KIND.COLLECTIONS}, ${TASKS_TYPE} tasks)`,
      actions: ACTION,
      entry: "submitReport(bytes report)",
      view: "checkTasks((uint8 action,uint256 id)[]) returns (bool[])",
      retry: { event: "PolarisCheckout.Reauthorized(address indexed buyer,uint256 value,uint256 deadline)", view: "dueTasksFor(address)" },
    },
    underwriting: {
      receiver: addresses.UnderwritingReceiver,
      report: `abi.encode(uint8 kind = ${REPORT_KIND.UNDERWRITING}, ${UNDERWRITINGS_TYPE} items)`,
      entry: "submitReport(bytes report)",
    },
    guard: { contract: addresses.CreditGuard, reasons: GUARD_REASON, overrides: GUARD_OVERRIDE, view: "creditStatus()", priceFeed: cfg.network.feeds?.usdcUsd ?? null },
  };
  record.ccip = cfg.network.ccip
    ? { ...cfg.network.ccip, receiver: addresses.PolarisCCIPReceiver, senders: {}, note: "Deploy PolarisCCIPSender on each source chain (scripts/ccip-deploy-sender.js), then allowlist it here (scripts/ccip-allow-sender.js)." }
    : null;
  record.feeds = cfg.network.feeds ?? null;
  record.eip712 = await domains(ethers, addresses, usdc, eurc);
  record.gas = { totalUsed: gasUsed.toString(), totalCostUsdc: ethers.formatUnits(gasCost, 18) };
  return record;
}

/** A Foundry artifact from ccip/out (run `forge build` first; the deploy script does). */
function foundryArtifact(name) {
  const file = path.join(__dirname, "..", "ccip", "out", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) {
    execFileSync("forge", ["build"], { cwd: path.join(__dirname, ".."), stdio: "inherit" });
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Circle's token on Arc: check its EIP-712 domain and decimals, and record it. */
async function useCircleToken(ethers, deployer, address, symbol, record, addresses, log) {
  const a = getAddress(address);
  if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`No ${symbol} code at ${a}`);
  const token = await ethers.getContractAt("MockUSDC", a, deployer); // the same 2612/3009 surface
  const d = await readDomain(token);
  if (d.name !== symbol || d.version !== USDC_DOMAIN.version) throw new Error(`${symbol} EIP-712 domain changed: ${JSON.stringify(domainJson(d))}`);
  if (Number(await token.decimals()) !== 6) throw new Error(`${symbol} decimals changed`);
  record.contracts[symbol] = { address: a, kind: `Circle ${symbol} on Arc`, abi: "abi/IUSDC.json" };
  addresses[symbol] = a;
  log(`  ${symbol.padEnd(22)} ${a}  (Circle ${symbol}, domain "${d.name}" v${d.version}, 6 decimals: verified)`);
  return token;
}

async function createPlan(payments, merchant, price, period, name, tally) {
  const receipt = await tx.send(payments, "createPlanFor", [merchant, price, period, name]);
  tally(receipt);
  const ev = receipt.logs
    .map((l) => {
      try {
        return payments.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "PlanCreated");
  return ev.args.planId;
}

async function domains(ethers, addresses, usdc, eurc) {
  const out = {};
  for (const name of Object.keys(DOMAIN_NAMES)) {
    const c = await ethers.getContractAt(name, addresses[name]);
    out[name] = { domain: domainJson(await readDomain(c)), types: TYPES[name] };
  }
  out.USDC = { domain: domainJson(await readDomain(usdc)), types: TYPES.Stablecoin };
  if (eurc) out.EURC = { domain: domainJson(await readDomain(eurc)), types: TYPES.Stablecoin };
  if (addresses.PolarisSendEURC) {
    const c = await ethers.getContractAt("PolarisSend", addresses.PolarisSendEURC);
    out.PolarisSendEURC = { domain: domainJson(await readDomain(c)), types: TYPES.PolarisSend };
  }
  return out;
}

/** { sourceCommit } for the record: HEAD, with sourceDirty when contracts/ has uncommitted changes. {} outside git. */
function sourceCommitOf(log = () => {}) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "../contracts"], { cwd: __dirname, encoding: "utf8" }).trim() !== "";
    if (dirty) log("  WARNING: contracts/ has uncommitted changes: verification cannot rebuild this bytecode from any commit");
    return dirty ? { sourceCommit: commit, sourceDirty: true } : { sourceCommit: commit };
  } catch {
    return {};
  }
}

/** Bigints as decimal strings, recursively, so a record serialises. */
function jsonSafe(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

function randomWallet() {
  return Wallet.createRandom();
}

module.exports = { deployPolaris, USD, randomWallet, jsonSafe, sourceCommitOf };
