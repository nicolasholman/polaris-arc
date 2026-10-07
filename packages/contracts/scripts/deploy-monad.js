/**
 * Deploy the whole Polaris contract layer to Monad testnet (chain 10143), or to
 * a local Hardhat node for the end-to-end run, and write the deployment record.
 *
 *   pnpm --filter @polarispay/contracts deploy:monad     # Monad testnet
 *   pnpm --filter @polarispay/contracts deploy:local     # node on :8600 (see e2e:local)
 *   pnpm --filter @polarispay/contracts deploy:fork      # a local anvil fork of testnet, real AUSD
 *
 * Writes deployments/monad-testnet.json (or monad-local.json, or the
 * git-ignored monad-fork.json for a fork; a fork never writes the testnet
 * record, and testnet refuses an RPC that is a local node): every address
 * with its block number and transaction, the ABI path for each, the EIP-712
 * domains and struct types clients sign, the roles granted, the CRE wiring and
 * the demo merchant.
 *
 * Order: stablecoin, ScoreManager, PolarisLoanEngine, PolarisPayments,
 * MerchantRegistry, CollateralVault, BatchSettlement, PolarisSend,
 * PolarisSplit, PolarisCheckout, (MockKeystoneForwarder, local only), CollectionsReceiver,
 * UnderwritingReceiver, GuardianReceiver (with its thresholds), (MockPriceFeed
 * as MockAusdUsdFeed, local only); then roles, including the checkout's
 * credit guardian; then the demo merchant (registered by its own signature)
 * and two subscription plans; then the credit pool.
 *
 * After the CRE workflows are deployed (their ids exist only then), lock the
 * receivers to them with `lock-receivers:monad` (scripts/lock-receivers.js).
 *
 * Environment (all optional; the repo-root .env is read by hardhat.config.js):
 *   DEPLOYER_PRIVATE_KEY        testnet deployer (scripts/deployer.js creates one)
 *   AUSD_MODE                   "ausd" (testnet and fork default: Agora AUSD, domain
 *                               checked on deploy) or "mock" (local default: a MockAUSD)
 *   TREASURY                    fee and interest recipient (default: deployer)
 *   GRACE_SECONDS               LoanEngine grace (testnet 3600, local 120)
 *   MIN_INTERVAL_SECONDS        shortest instalment interval (default 60: a whole
 *                               plan plays out on camera; weekly plans still work)
 *   MIN_PERIOD_SECONDS          shortest subscription period (default 60)
 *   CRE_FORWARDER               "simulation" (testnet default: Chainlink's
 *                               MockKeystoneForwarder, for `cre workflow simulate
 *                               --broadcast`) or "production" (KeystoneForwarder,
 *                               once deploy access is granted)
 *   CRE_SIMULATION_TRANSMITTER  the address of CRE_ETH_PRIVATE_KEY, the key
 *                               `cre workflow simulate --broadcast` signs with: the
 *                               only origin the three receivers accept while on
 *                               the mock forwarder. Required for "simulation"
 *                               (read from CRE_ETH_PRIVATE_KEY in the environment
 *                               or .env when unset) and never the deployer. A
 *                               local node defaults to the deployer, a fork to
 *                               the node's second account (no .env key is read on
 *                               a fork). Ignored for "production".
 *   CRE_WORKFLOW_OWNER          production only: the receivers then accept only
 *                               this workflow owner and the Polaris workflow names
 *   RELAYER_ADDRESS             the Privy server wallet that relays; gets operator
 *                               roles (or later: scripts/grant-relayer.js)
 *   DEMO_MERCHANT_PRIVATE_KEY   testnet demo merchant (created in .env if missing)
 *   POOL_SEED_AUSD              credit pool target in dollars (testnet 10000,
 *                               local 100000); testnet seeds what the deployer holds
 *   GUARD_MIN_PRICE             GuardianReceiver: lowest AUSD/USD that is not a
 *                               depeg, in dollars (0.995)
 *   GUARD_MAX_PRICE             highest AUSD/USD that is not a depeg (1.005)
 *   GUARD_MIN_FREE_CASH_AUSD    least free pool cash, in dollars (1000)
 *   GUARD_MAX_BAD_DEBT_BPS      most bad debt, basis points of lifetime
 *                               originations (500)
 *   GUARD_MIN_ORIGINATED_AUSD   lifetime originations, in dollars, before the
 *                               bad-debt ratio applies (10000)
 *   GUARD_MAX_PRICE_AGE_SECONDS oldest the cited AUSD/USD round may be (7200)
 *   GUARD_MAX_ATTESTATION_AGE_SECONDS  past this the guardian's attestation is
 *                               stale and Pay in 4 fails open (3600)
 */

"use strict";

const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");
const { Wallet, ZeroAddress, getAddress, formatEther, parseUnits } = require("ethers");
const { GUARDIAN_DEFAULTS, GUARDIAN_PRICE_DECIMALS } = require("../lib/cre");

const { deployPolaris, MONAD_TESTNET } = require("../lib/deploy");
const { devNodeInfo, requireForkNode } = require("../lib/fork");
const { ensureEnvKey, readEnvValue } = require("./lib/env");

const LOCAL_NETWORKS = new Set(["hardhat", "localhost", "monadLocal"]);
/** Local forks of Monad testnet: real AUSD, the node's own test accounts, a git-ignored record. */
const FORK_NETWORKS = new Set(["monadFork"]);

function deploymentFile(networkName) {
  if (networkName === "monadTestnet") return "monad-testnet.json";
  if (LOCAL_NETWORKS.has(networkName)) return "monad-local.json";
  if (FORK_NETWORKS.has(networkName)) return "monad-fork.json";
  return `${networkName}.json`;
}

/** Contract sizes, for a rough cost preflight before spending anything. */
async function roughDeploymentGas() {
  const names = [
    "ScoreManager", "PolarisLoanEngine", "PolarisPayments", "MerchantRegistry", "CollateralVault",
    "BatchSettlement", "PolarisSend", "PolarisSplit", "PolarisCheckout", "CollectionsReceiver", "UnderwritingReceiver",
    "GuardianReceiver",
  ];
  let gas = 0n;
  for (const n of names) {
    const a = await hre.artifacts.readArtifact(n);
    const code = BigInt((a.deployedBytecode.length - 2) / 2);
    const init = BigInt((a.bytecode.length - 2) / 2);
    gas += 53_000n + 200n * code + 16n * init + 200_000n; // creation + code deposit + calldata + constructor storage
  }
  // About 30 wiring and demo transactions.
  return gas + 30n * 150_000n;
}

/**
 * The only transaction origin the receivers (collections, underwriting,
 * guardian) accept reports from while they sit behind a simulation forwarder.
 *
 * Chainlink's MockKeystoneForwarder is a public contract anyone can call, so
 * under it the receiver's one guard is `tx.origin == simulationTransmitter`.
 * Whatever contract the transmitter's key calls can therefore deliver a
 * forged underwriting report. The deployer's key calls a great deal, so on a
 * public network the transmitter must be a key kept for `cre workflow
 * simulate --broadcast` alone: CRE_SIMULATION_TRANSMITTER, or the address of
 * CRE_ETH_PRIVATE_KEY. A local node, where nothing is at stake, defaults to
 * the deployer (the CRE package's local chain relies on that). The
 * production forwarder checks DON signatures, so it needs no transmitter.
 */
function simulationTransmitterFor(forwarderKind, deployer, env = process.env, readKey = readEnvValue) {
  if (forwarderKind === "production") return ZeroAddress;
  if (env.CRE_SIMULATION_TRANSMITTER) {
    const transmitter = getAddress(env.CRE_SIMULATION_TRANSMITTER);
    if (forwarderKind !== "local") refuseDeployerAsTransmitter(transmitter, deployer);
    return transmitter;
  }
  if (forwarderKind === "local") return deployer.address;
  const key = readKey("CRE_ETH_PRIVATE_KEY");
  if (!key) {
    throw new Error(
      "The simulation forwarder needs a dedicated CRE transmitter. Set CRE_SIMULATION_TRANSMITTER to the " +
        "address of the key `cre workflow simulate --broadcast` signs with (CRE_ETH_PRIVATE_KEY in " +
        "workflows/.env), a key used for nothing else and funded with a little testnet MON."
    );
  }
  const transmitter = new Wallet(key.startsWith("0x") ? key : `0x${key}`).address;
  refuseDeployerAsTransmitter(transmitter, deployer);
  return transmitter;
}

function refuseDeployerAsTransmitter(transmitter, deployer) {
  if (transmitter === getAddress(deployer.address)) {
    throw new Error(
      "The CRE simulation transmitter must not be the deployer: while the simulation forwarder is in use, " +
        "any contract the transmitter's key calls could deliver underwriting facts. Use a dedicated " +
        "CRE_ETH_PRIVATE_KEY and set CRE_SIMULATION_TRANSMITTER to its address."
    );
  }
}

/**
 * The fork's simulation transmitter when none is given: the node's second
 * unlocked account (the deployer is the first), so no .env key is read.
 */
function forkTransmitter(accounts, deployer) {
  const second = accounts[1]?.address;
  if (!second) throw new Error("The fork node has one account; set CRE_SIMULATION_TRANSMITTER to an address other than the deployer.");
  const transmitter = getAddress(second);
  refuseDeployerAsTransmitter(transmitter, deployer);
  return transmitter;
}

/**
 * @param {string} networkName
 * @param {{address: string}} deployer
 * @param {{env?: object, accounts?: {address: string}[]}} [opts]  the environment
 *        (process.env), and the node's signers (a fork's transmitter default)
 */
async function buildConfig(networkName, deployer, { env = process.env, accounts = [] } = {}) {
  const local = LOCAL_NETWORKS.has(networkName);
  const fork = FORK_NETWORKS.has(networkName);
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

  const tokenMode = env.AUSD_MODE || (local ? "mock" : "ausd");
  if (!["ausd", "mock"].includes(tokenMode)) throw new Error(`AUSD_MODE must be "ausd" or "mock"`);
  if (local && tokenMode === "ausd") throw new Error("A local node has no AUSD; use AUSD_MODE=mock");

  const forwarderKind = local ? "local" : env.CRE_FORWARDER || "simulation";
  if (!["local", "simulation", "production"].includes(forwarderKind)) {
    throw new Error(`CRE_FORWARDER must be "simulation" or "production"`);
  }
  const forwarderAddress =
    forwarderKind === "simulation"
      ? MONAD_TESTNET.CRE_MOCK_FORWARDER
      : forwarderKind === "production"
        ? MONAD_TESTNET.CRE_KEYSTONE_FORWARDER
        : undefined;

  const simulationTransmitter =
    fork && forwarderKind === "simulation" && !env.CRE_SIMULATION_TRANSMITTER
      ? forkTransmitter(accounts, deployer)
      : simulationTransmitterFor(forwarderKind, deployer, env, fork ? () => undefined : readEnvValue);

  let demoMerchant;
  if (local || fork) {
    demoMerchant = Wallet.createRandom();
  } else {
    const key = ensureEnvKey("DEMO_MERCHANT_PRIVATE_KEY", "Polaris demo merchant (testnet only)");
    demoMerchant = new Wallet(key);
  }

  return {
    ...guardianConfig(env),
    tokenMode,
    tokenAddress: tokenMode === "ausd" ? MONAD_TESTNET.AUSD : undefined,
    treasury: env.TREASURY ? getAddress(env.TREASURY) : deployer.address,
    graceSeconds: num(env.GRACE_SECONDS, local ? 120 : 3600),
    minInterval: num(env.MIN_INTERVAL_SECONDS, 60),
    minPeriod: num(env.MIN_PERIOD_SECONDS, 60),
    forwarderKind,
    forwarderAddress,
    simulationTransmitter,
    workflowOwner: env.CRE_WORKFLOW_OWNER ? getAddress(env.CRE_WORKFLOW_OWNER) : undefined,
    relayer: env.RELAYER_ADDRESS ? getAddress(env.RELAYER_ADDRESS) : undefined,
    demoMerchant,
    poolSeed: parseUnits(String(num(env.POOL_SEED_AUSD, local ? 100_000 : 10_000)), 6),
    mintToDeployer: local ? parseUnits("1000000", 6) : 0n,
  };
}

/**
 * GuardianReceiver's thresholds and staleness from the environment, with
 * lib/cre.js GUARDIAN_DEFAULTS (decisions 9 and 10, the $1.005 ceiling and
 * the $10,000 floor for the bad-debt ratio) for any unset.
 */
function guardianConfig(env = process.env) {
  const set = (v) => v !== undefined && v !== "";
  const int = (name, fallback) => {
    if (!set(env[name])) return fallback;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
    return n;
  };
  return {
    guardianThresholds: {
      minPrice: set(env.GUARD_MIN_PRICE) ? parseUnits(String(env.GUARD_MIN_PRICE), GUARDIAN_PRICE_DECIMALS) : GUARDIAN_DEFAULTS.minPrice,
      maxPrice: set(env.GUARD_MAX_PRICE) ? parseUnits(String(env.GUARD_MAX_PRICE), GUARDIAN_PRICE_DECIMALS) : GUARDIAN_DEFAULTS.maxPrice,
      minFreeCash: set(env.GUARD_MIN_FREE_CASH_AUSD) ? parseUnits(String(env.GUARD_MIN_FREE_CASH_AUSD), 6) : GUARDIAN_DEFAULTS.minFreeCash,
      maxBadDebtBps: int("GUARD_MAX_BAD_DEBT_BPS", GUARDIAN_DEFAULTS.maxBadDebtBps),
      minOriginated: set(env.GUARD_MIN_ORIGINATED_AUSD) ? parseUnits(String(env.GUARD_MIN_ORIGINATED_AUSD), 6) : GUARDIAN_DEFAULTS.minOriginated,
      maxPriceAge: int("GUARD_MAX_PRICE_AGE_SECONDS", GUARDIAN_DEFAULTS.maxPriceAge),
    },
    maxAttestationAge: int("GUARD_MAX_ATTESTATION_AGE_SECONDS", GUARDIAN_DEFAULTS.maxAttestationAge),
  };
}

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId === 143n) {
    throw new Error("Refusing Monad mainnet: credit stays on testnet (plan section 6, WON'T).");
  }
  await refuseWrongNode(networkName, hre.ethers.provider);
  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer key. Run `pnpm --filter @polarispay/contracts deployer` first.");
  }
  const [deployer] = signers;
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const local = LOCAL_NETWORKS.has(networkName);
  const fork = FORK_NETWORKS.has(networkName);

  console.log(`Network   ${networkName} (chain ${chainId})`);
  console.log(`Deployer  ${deployer.address}`);
  console.log(`Balance   ${formatEther(balance)} MON`);

  if (!local) {
    // Monad charges min(base + tip, maxFee) per unit of gas LIMIT; eth_gasPrice
    // is base + tip. maxFeePerGas (2 x base + tip) would double the estimate.
    const { gasPrice, maxFeePerGas } = await hre.ethers.provider.getFeeData();
    const price = gasPrice ?? maxFeePerGas;
    const need = ((await roughDeploymentGas()) * price * 115n) / 100n;
    console.log(`Needs     about ${formatEther(need)} MON at ${hre.ethers.formatUnits(price, "gwei")} gwei (rough)`);
    if (balance < need) {
      throw new Error(
        `The deployer holds ${formatEther(balance)} MON, about ${formatEther(need)} is needed. ` +
          `Fund ${deployer.address} from the Monad testnet faucet (https://testnet.monad.xyz), then rerun.`
      );
    }
  }

  const cfg = await buildConfig(networkName, deployer, { accounts: signers });
  console.log(`Token     ${cfg.tokenMode === "ausd" ? `AUSD ${cfg.tokenAddress}` : "MockAUSD (new)"}`);
  console.log(`CRE       ${cfg.forwarderKind} forwarder ${cfg.forwarderAddress ?? "(deployed locally)"}`);
  if (cfg.simulationTransmitter !== ZeroAddress) console.log(`CRE sim   transmitter ${cfg.simulationTransmitter}`);
  console.log("");

  const record = await deployPolaris(hre, cfg, (line) => console.log(line));
  record.abiDir = "packages/contracts/abi";
  record.explorer = local || fork ? null : MONAD_TESTNET.EXPLORER;
  if (local) record.demo.merchantPrivateKey = cfg.demoMerchant.privateKey; // local test key only

  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, deploymentFile(networkName));
  writeFileSync(file, `${JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);

  const spent = balance - (await hre.ethers.provider.getBalance(deployer.address));
  console.log(`\nSpent     ${formatEther(spent)} MON`);
  console.log(`Wrote     ${file}`);
  if (BigInt(record.demo.poolSeeded) === 0n) {
    console.log(
      fork
        ? "\nThe credit pool is empty. Fill it with real AUSD from Agora's faucet on the fork: " +
            "`pnpm --filter @polarispay/contracts fund-pool:fork`."
        : "\nThe credit pool is empty. Send AUSD to the deployer and run " +
            "`pnpm --filter @polarispay/contracts fund-pool:monad`, or redeploy with AUSD_MODE=mock."
    );
  }
}

/**
 * A fork network must be a local fork of Monad testnet (lib/fork.js), and
 * Monad testnet must not be a local node: pointing MONAD_TESTNET_RPC_URL at
 * a fork would otherwise overwrite the testnet record with the fork's.
 */
async function refuseWrongNode(networkName, provider) {
  if (FORK_NETWORKS.has(networkName)) {
    await requireForkNode(provider);
  } else if (networkName === "monadTestnet") {
    const dev = await devNodeInfo(provider);
    if (dev) {
      throw new Error(
        `monadTestnet points at a local ${dev.kind} node, not Monad testnet. Use --network monadFork ` +
          "(deploy:fork) for a fork; it writes deployments/monad-fork.json."
      );
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage ?? e.message ?? e);
    process.exitCode = 1;
  });
}

module.exports = { buildConfig, deploymentFile, simulationTransmitterFor, guardianConfig, refuseWrongNode, LOCAL_NETWORKS, FORK_NETWORKS };
