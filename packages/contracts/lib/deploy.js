/**
 * Deploy and wire the whole Polaris contract layer, in dependency order.
 *
 * Used by scripts/deploy-monad.js (Monad testnet, or a local Hardhat node for
 * the end-to-end run) and by test/metropolis/Deploy.test.js, which runs it
 * in-process and checks every role it grants. It returns a plain record; the
 * script decides where to write it.
 *
 * Every transaction goes through lib/tx.js, so each carries an estimated gas
 * limit plus 15% (Monad bills the limit).
 */

"use strict";

const { Wallet, ZeroAddress, getAddress, id: eventTopic } = require("ethers");

const tx = require("./tx");
const { headSource } = require("./verify");
const { TYPES, DOMAIN_NAMES, AUSD_DOMAIN_NAME, readDomain, domainJson } = require("./eip712");
const {
  ACTION,
  REPORT_KIND,
  WORKFLOW_NAMES,
  TASKS_TYPE,
  UNDERWRITINGS_TYPE,
  ATTESTATION_TYPE,
  GUARDIAN_REASON,
  GUARDIAN_OVERRIDE,
  GUARDIAN_DEFAULTS,
  GUARDIAN_PRICE_DECIMALS,
  guardianThresholds: toGuardianThresholds,
  AUSD_USD_FEED_MONAD_MAINNET,
  workflowNameBytes10,
} = require("./cre");

/** Addresses on Monad testnet (10143), verified in docs/research/ausd.md and cre.md. */
const MONAD_TESTNET = {
  chainId: 10143,
  AUSD: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
  CRE_MOCK_FORWARDER: "0xB9F79d863261869B234c481D1f9A7af84AeAd192", // `cre workflow simulate`
  CRE_KEYSTONE_FORWARDER: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482", // deployed workflows
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  EXPLORER: "https://testnet.monadscan.com",
};

const USD = (n) => BigInt(Math.round(Number(n) * 1e6));

/**
 * @typedef {object} DeployConfig
 * @property {"ausd"|"mock"} tokenMode  real AUSD at `tokenAddress`, or a fresh MockAUSD
 * @property {string} [tokenAddress]
 * @property {string} treasury
 * @property {number} graceSeconds      LoanEngine grace period
 * @property {number} minInterval       LoanEngine minimum instalment interval
 * @property {number} minPeriod         PolarisPayments minimum subscription period
 * @property {"local"|"simulation"|"production"} forwarderKind
 * @property {string} [forwarderAddress] required unless forwarderKind is "local"
 * @property {string} simulationTransmitter  the three receivers' origin guard (zero to disable)
 * @property {{minPrice?: bigint, maxPrice?: bigint, minFreeCash?: bigint, maxBadDebtBps?: number, minOriginated?: bigint, maxPriceAge?: number}} [guardianThresholds]
 *                                      GuardianReceiver thresholds (default: lib/cre.js GUARDIAN_DEFAULTS)
 * @property {number} [maxAttestationAge] seconds before the guardian's attestation is stale and credit fails open (3600)
 * @property {string} [workflowOwner]   production only: expected CRE workflow owner
 * @property {string} [relayer]         Privy server wallet that relays; gets operator roles
 * @property {import("ethers").Wallet} demoMerchant  signs its own registration
 * @property {bigint} poolSeed          AUSD base units to fund the credit pool with
 * @property {bigint} [mintToDeployer]  mock only: extra test dollars for the deployer
 */

async function deployPolaris(hre, cfg, log = () => {}) {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  // Behind Chainlink's public simulation forwarder the transmitter's tx.origin
  // is UnderwritingReceiver's only guard, so it must be a key kept for the CRE
  // simulator alone: never missing, never the deployer's (see
  // scripts/deploy-monad.js, simulationTransmitterFor). Checked before
  // anything is sent.
  if (cfg.forwarderKind === "simulation") {
    const t = cfg.simulationTransmitter;
    if (!t || getAddress(t) === ZeroAddress) {
      throw new Error("A simulation forwarder needs a simulationTransmitter, or anyone can write credit facts.");
    }
    if (getAddress(t) === deployer.address) {
      throw new Error("The CRE simulation transmitter must be a dedicated key, not the deployer.");
    }
  }
  const net = await ethers.provider.getNetwork();
  const record = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    // The commit the bytecode is built from: what verify:monad submits for a
    // contract whose sources change later (lib/verify.js).
    ...sourceCommitOf(log),
    contracts: {},
    config: {},
    roles: {},
    demo: {},
  };
  const addresses = {};

  async function deployContract(name, args, label = name) {
    const factory = await ethers.getContractFactory(name, deployer);
    const d = await tx.deploy(factory, args);
    record.contracts[label] = {
      address: d.address,
      blockNumber: d.receipt.blockNumber,
      txHash: d.receipt.hash,
      gasUsed: d.receipt.gasUsed.toString(),
      abi: `abi/${name}.json`,
      // The constructor arguments, JSON-safe, for verification (scripts/verify-monad.js):
      // later reconfiguration (lock-receivers) changes what the record says elsewhere.
      args: jsonSafe(args),
    };
    addresses[label] = d.address;
    log(`  ${label.padEnd(22)} ${d.address}  (block ${d.receipt.blockNumber}, gas ${d.receipt.gasUsed})`);
    return d.contract;
  }

  const send = (contract, method, args) => tx.send(contract, method, args);

  // ---------------------------------------------------------------- token
  log("Stablecoin");
  let token;
  if (cfg.tokenMode === "mock") {
    token = await deployContract("MockAUSD", [], "Stablecoin");
    record.contracts.Stablecoin.kind = "MockAUSD";
  } else {
    const address = getAddress(cfg.tokenAddress);
    if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No token code at ${address}`);
    token = await ethers.getContractAt("MockAUSD", address, deployer); // same 2612/3009/5267 surface
    const d = await readDomain(token);
    if (d.name !== AUSD_DOMAIN_NAME.name || d.version !== AUSD_DOMAIN_NAME.version) {
      throw new Error(`AUSD EIP-712 domain changed: ${JSON.stringify(domainJson(d))}`);
    }
    if (Number(await token.decimals()) !== 6) throw new Error("AUSD decimals changed");
    record.contracts.Stablecoin = { address, kind: "AUSD", abi: "abi/IAUSD.json" };
    addresses.Stablecoin = address;
    log(`  Stablecoin             ${address}  (Agora AUSD, domain verified)`);
  }

  // ------------------------------------------------------------- core
  log("Core");
  const scores = await deployContract("ScoreManager", [deployer.address]);
  const engine = await deployContract("PolarisLoanEngine", [
    deployer.address,
    addresses.Stablecoin,
    addresses.ScoreManager,
    cfg.treasury,
    cfg.graceSeconds,
    cfg.minInterval,
  ]);
  const payments = await deployContract("PolarisPayments", [
    deployer.address,
    addresses.Stablecoin,
    cfg.treasury,
    cfg.minPeriod,
  ]);
  const registry = await deployContract("MerchantRegistry", [deployer.address]);
  const vault = await deployContract("CollateralVault", [deployer.address, addresses.Stablecoin]);
  const batch = await deployContract("BatchSettlement", [deployer.address, addresses.Stablecoin]);
  await deployContract("PolarisSend", [addresses.Stablecoin]);
  // Split the bill by link: no owner, no roles, no custody (contracts/PolarisSplit.sol).
  await deployContract("PolarisSplit", [addresses.Stablecoin]);
  const checkout = await deployContract("PolarisCheckout", [
    deployer.address,
    addresses.PolarisLoanEngine,
    addresses.PolarisPayments,
    addresses.ScoreManager,
  ]);

  // -------------------------------------------------------------- CRE
  log("Chainlink CRE");
  let forwarder = cfg.forwarderAddress;
  if (cfg.forwarderKind === "local") {
    await deployContract("MockKeystoneForwarder", [], "MockKeystoneForwarder");
    forwarder = addresses.MockKeystoneForwarder;
  }
  if (!forwarder) throw new Error("forwarderAddress is required");
  const transmitter = cfg.simulationTransmitter ?? ZeroAddress;
  const collections = await deployContract("CollectionsReceiver", [
    forwarder,
    addresses.PolarisLoanEngine,
    addresses.PolarisPayments,
    transmitter,
  ]);
  const underwriting = await deployContract("UnderwritingReceiver", [
    forwarder,
    addresses.ScoreManager,
    transmitter,
  ]);
  const guardianThresholds = toGuardianThresholds(cfg.guardianThresholds ?? {});
  const maxAttestationAge = Number(cfg.maxAttestationAge ?? GUARDIAN_DEFAULTS.maxAttestationAge);
  const guardian = await deployContract("GuardianReceiver", [
    forwarder,
    addresses.PolarisLoanEngine,
    transmitter,
    guardianThresholds,
    maxAttestationAge,
  ]);
  // The guardian reads Chainlink AUSD/USD on Monad mainnet. A local chain has
  // no mainnet, so it gets a clearly labelled stand-in to point the workflow at.
  let priceFeed = { ...AUSD_USD_FEED_MONAD_MAINNET, kind: "chainlink" };
  if (cfg.forwarderKind === "local") {
    await deployContract("MockPriceFeed", [8, "AUSD / USD (local mock, not Chainlink)", 99_980_000n], "MockAusdUsdFeed");
    priceFeed = {
      chainId: record.chainId,
      chainSelectorName: null,
      address: addresses.MockAusdUsdFeed,
      decimals: 8,
      description: "AUSD / USD (local mock, not Chainlink)",
      kind: "mock",
    };
  }

  // ------------------------------------------------------------ wiring
  log("Roles");
  await send(scores, "setWriter", [addresses.PolarisLoanEngine, true]);
  await send(scores, "setUnderwriter", [addresses.UnderwritingReceiver, true]);
  await send(scores, "setCollateralVault", [addresses.CollateralVault]);
  // A fresh Face ID account costs nothing, so no unsecured line opens without
  // a DON report (ScoreManager.requireUnderwriting), and no report opens one
  // without a history behind it (ScoreManager.isThinFile).
  await send(scores, "setRequireUnderwriting", [true]);
  await send(vault, "setLoanEngine", [addresses.PolarisLoanEngine]);
  await send(vault, "setSeizer", [addresses.PolarisLoanEngine, true]);
  await send(engine, "setCollateralVault", [addresses.CollateralVault]);
  await send(engine, "setMerchantRegistry", [addresses.MerchantRegistry]);
  await send(engine, "setOriginator", [addresses.PolarisCheckout, true]);
  await send(payments, "setCheckout", [addresses.PolarisCheckout]);
  await send(checkout, "setCreditGuardian", [addresses.GuardianReceiver]);
  log("  ScoreManager: writer = LoanEngine, underwriter = UnderwritingReceiver, requireUnderwriting");
  log("  LoanEngine: originator = PolarisCheckout (only), vault, registry");
  log("  PolarisPayments: checkout = PolarisCheckout");
  log(
    `  PolarisCheckout: credit guardian = GuardianReceiver (depeg < $${Number(guardianThresholds.minPrice) / 1e8} or > $${Number(guardianThresholds.maxPrice) / 1e8}, ` +
      `cash < $${Number(guardianThresholds.minFreeCash) / 1e6}, bad debt > ${guardianThresholds.maxBadDebtBps / 100}% once $${Number(guardianThresholds.minOriginated) / 1e6} is lent, ` +
      `price older than ${guardianThresholds.maxPriceAge}s; price stale after ${maxAttestationAge}s)`
  );

  if (cfg.relayer) {
    await send(payments, "setOperator", [cfg.relayer, true]);
    await send(registry, "setOperator", [cfg.relayer, true]);
    await send(batch, "setSettler", [cfg.relayer, true]);
    log(`  relayer ${cfg.relayer}: PolarisPayments operator, MerchantRegistry operator, BatchSettlement settler`);
  }

  if (cfg.forwarderKind === "production" && cfg.workflowOwner) {
    // The workflow ids exist only once each workflow is deployed; pin them
    // with scripts/lock-receivers.js (lock-receivers:monad) afterwards.
    for (const [receiver, name] of [
      [collections, WORKFLOW_NAMES.COLLECTIONS],
      [underwriting, WORKFLOW_NAMES.UNDERWRITING],
      [guardian, WORKFLOW_NAMES.GUARDIAN],
    ]) {
      await send(receiver, "setExpectedAuthor", [cfg.workflowOwner]);
      await send(receiver, "setExpectedWorkflowName", [name]);
    }
    log(`  receivers accept only workflow owner ${cfg.workflowOwner} and the Polaris workflow names`);
  }

  // --------------------------------------------------------- demo data
  log("Demo merchant");
  const merchant = cfg.demoMerchant.connect(ethers.provider);
  const regDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
  const regMessage = {
    merchant: merchant.address,
    name: "Polaris Demo Studio",
    payoutAddress: merchant.address,
    metadataURI: "https://polarispay.app/demo/merchant.json",
    nonce: await registry.nonces(merchant.address),
    deadline: regDeadline,
  };
  const regSig = await merchant.signTypedData(await readDomain(registry), { Registration: TYPES.MerchantRegistry.Registration }, regMessage);
  await send(registry, "registerFor", [
    regMessage.merchant,
    regMessage.name,
    regMessage.payoutAddress,
    regMessage.metadataURI,
    regDeadline,
    regSig,
  ]);
  await send(registry, "setActive", [merchant.address, true]);
  await send(registry, "setMaxOrderValue", [merchant.address, USD(1_000)]);
  log(`  ${merchant.address} registered by its own signature, active, cap $1,000`);

  const monthly = BigInt(30 * 24 * 3600);
  const planMonthly = await _createPlan(payments, merchant.address, USD(9.99), monthly, "Studio Pro, monthly");
  const planFast = await _createPlan(payments, merchant.address, USD(1), BigInt(cfg.minPeriod), "Demo, every period");
  log(`  subscription plans #${planMonthly} ($9.99 / 30 days) and #${planFast} ($1 / ${cfg.minPeriod}s)`);

  record.demo = {
    merchant: merchant.address,
    merchantName: regMessage.name,
    subscriptionPlans: [
      { planId: planMonthly.toString(), name: "Studio Pro, monthly", pricePerPeriod: USD(9.99).toString(), periodSeconds: monthly.toString() },
      { planId: planFast.toString(), name: "Demo, every period", pricePerPeriod: USD(1).toString(), periodSeconds: String(cfg.minPeriod) },
    ],
  };

  // ------------------------------------------------------------- pool
  log("Credit pool");
  if (cfg.tokenMode === "mock") {
    await send(token, "mint", [deployer.address, cfg.poolSeed + (cfg.mintToDeployer ?? 0n)]);
  }
  const held = await token.balanceOf(deployer.address);
  const seed = held < cfg.poolSeed ? held : cfg.poolSeed;
  if (seed > 0n) {
    await send(token, "approve", [addresses.PolarisLoanEngine, seed]);
    await send(engine, "fund", [seed]);
    log(`  funded ${ethers.formatUnits(seed, 6)} AUSD`);
  } else {
    log("  NOT funded: the deployer holds no AUSD. Pay in 4 will refuse until the pool is funded (see README).");
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
    guardian: guardianRecordConfig(guardianThresholds, maxAttestationAge),
  };
  record.roles = {
    owner: deployer.address,
    loanEngineOriginators: [addresses.PolarisCheckout],
    paymentsCheckout: addresses.PolarisCheckout,
    scoreWriters: [addresses.PolarisLoanEngine],
    scoreUnderwriters: [addresses.UnderwritingReceiver],
    vaultSeizers: [addresses.PolarisLoanEngine],
    creditGuardian: addresses.GuardianReceiver,
    relayer: cfg.relayer ?? null,
  };
  record.cre = {
    forwarderKind: cfg.forwarderKind,
    forwarder,
    simulationTransmitter: transmitter,
    workflowOwner: cfg.workflowOwner ?? null,
    workflows: {
      collections: {
        name: WORKFLOW_NAMES.COLLECTIONS,
        nameBytes10: workflowNameBytes10(WORKFLOW_NAMES.COLLECTIONS),
        receiver: addresses.CollectionsReceiver,
        report: `abi.encode(uint8 kind = ${REPORT_KIND.COLLECTIONS}, ${TASKS_TYPE} tasks)`,
        actions: ACTION,
        view: "checkTasks((uint8 action,uint256 id)[]) returns (bool[])",
        retry: {
          trigger: "EVM log",
          contract: addresses.PolarisCheckout,
          event: "Reauthorized(address indexed buyer,uint256 value,uint256 deadline)",
          topic0: eventTopic("Reauthorized(address,uint256,uint256)"),
          view: "dueTasksFor(address borrower) returns ((uint8 action,uint256 id)[])",
        },
      },
      underwrite: {
        name: WORKFLOW_NAMES.UNDERWRITING,
        nameBytes10: workflowNameBytes10(WORKFLOW_NAMES.UNDERWRITING),
        receiver: addresses.UnderwritingReceiver,
        report: `abi.encode(uint8 kind = ${REPORT_KIND.UNDERWRITING}, ${UNDERWRITINGS_TYPE} items)`,
      },
      guardian: {
        name: WORKFLOW_NAMES.GUARDIAN,
        nameBytes10: workflowNameBytes10(WORKFLOW_NAMES.GUARDIAN),
        receiver: addresses.GuardianReceiver,
        report: `abi.encode(uint8 kind = ${REPORT_KIND.GUARDIAN}, ${ATTESTATION_TYPE} attestation)`,
        reasons: GUARDIAN_REASON,
        overrides: GUARDIAN_OVERRIDE,
        priceDecimals: GUARDIAN_PRICE_DECIMALS,
        priceFeed,
        pool: addresses.PolarisLoanEngine,
        view: GUARDIAN_VIEW,
        feed: { description: "Polaris pool health, computed by CRE", decimals: GUARDIAN_PRICE_DECIMALS, address: addresses.GuardianReceiver },
      },
    },
  };
  record.eip712 = await _domains(ethers, addresses, token);
  return record;
}

async function _createPlan(payments, merchant, price, period, name) {
  const receipt = await tx.send(payments, "createPlanFor", [merchant, price, period, name]);
  const ev = receipt.logs.map((l) => { try { return payments.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "PlanCreated");
  return ev.args.planId;
}

async function _domains(ethers, addresses, token) {
  const at = (name, label = name) => ethers.getContractAt(name, addresses[label]);
  const out = {};
  for (const name of Object.keys(DOMAIN_NAMES)) {
    out[name] = { domain: domainJson(await readDomain(await at(name))), types: TYPES[name] };
  }
  out.Stablecoin = { domain: domainJson(await readDomain(token)), types: TYPES.Stablecoin };
  return out;
}

/** GuardianReceiver.currentInputs(), as the deployment record describes it to the workflow. */
const GUARDIAN_VIEW =
  "currentInputs() returns ((uint256 freeCash,uint256 totalOwed,uint256 badDebt,uint256 totalOriginated) state, " +
  "(int256 minPrice,int256 maxPrice,uint256 minFreeCash,uint16 maxBadDebtBps,uint256 minOriginated,uint32 maxPriceAge) limits, " +
  "uint256 acknowledgedBadDebt)";

/** The record's `config.guardian`: the thresholds as decimal strings and numbers, and the staleness. */
function guardianRecordConfig(t, maxAttestationAge) {
  return {
    minPrice: t.minPrice.toString(),
    maxPrice: t.maxPrice.toString(),
    minFreeCash: t.minFreeCash.toString(),
    maxBadDebtBps: Number(t.maxBadDebtBps),
    minOriginated: t.minOriginated.toString(),
    maxPriceAge: Number(t.maxPriceAge),
    maxAttestationAge: Number(maxAttestationAge),
  };
}

/**
 * { sourceCommit } for the record: the commit HEAD is at, with
 * sourceDirty: true (and a warning) when contracts/ has uncommitted changes,
 * which no commit reproduces. {} outside a git checkout.
 */
function sourceCommitOf(log = () => {}) {
  try {
    const { commit, dirty } = headSource();
    if (dirty) log("  WARNING: contracts/ has uncommitted changes: verify:monad cannot rebuild this bytecode from any commit");
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

/** A throwaway wallet for local runs, where every key is a test key anyway. */
function randomWallet() {
  return Wallet.createRandom();
}

module.exports = { deployPolaris, MONAD_TESTNET, USD, randomWallet, ZeroAddress, GUARDIAN_VIEW, guardianRecordConfig, jsonSafe, sourceCommitOf };
