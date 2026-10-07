/**
 * Deploy Polaris to Arc: NETWORK=testnet | mainnet | local.
 *
 *   NETWORK=testnet pnpm --filter @polarispay/contracts deploy:arc
 *
 * (The package scripts deploy:testnet / deploy:mainnet / deploy:local set
 * NETWORK and the Hardhat network together.) Writes
 * deployments/arc-<network>.json, the record every app reads.
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY      the deployer (owner of every contract). Never kept
 *                             in this repo: source it from its own file in the
 *                             command (MAINNET.md). Not needed for local.
 *   POLARIS_KEEPER_ADDRESS    the keeper EOA (services/keeper). Required on Arc.
 *   POLARIS_RELAYER_ADDRESS   the relayer EOA (apps/business). Optional.
 *   POLARIS_TREASURY          protocol fees (default: the deployer)
 *   POLARIS_POOL_SEED_USDC    USDC to fund the credit pool with (testnet 25, mainnet 0, local 50,000)
 *   POLARIS_GUARD_MIN_FREE_CASH_USDC  CreditGuard's free-cash floor (testnet 5, mainnet and local 1,000)
 *   POLARIS_DEMO_MERCHANT_KEY the demo merchant's key (default: a fresh one, saved
 *                             to deployments/.keys/, git-ignored)
 *   POLARIS_FAST_PLANS=1      minute-long instalment intervals and a 15-minute grace, for demos
 *   POLARIS_CONFIRM_MAINNET=yes  required for NETWORK=mainnet
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { Wallet, getAddress } = hre.ethers;

const { deployPolaris, USD } = require("../lib/deploy");
const { networkFor } = require("../lib/networks");

async function main() {
  const network = networkFor();
  if (hre.network.name !== network.hardhatNetwork) {
    throw new Error(`NETWORK=${network.key} needs --network ${network.hardhatNetwork} (got ${hre.network.name}).`);
  }
  if (network.key === "mainnet" && process.env.POLARIS_CONFIRM_MAINNET !== "yes") {
    throw new Error("Refusing to deploy to Arc mainnet without POLARIS_CONFIRM_MAINNET=yes (see MAINNET.md).");
  }
  const [deployer, ...localAccounts] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer: set DEPLOYER_PRIVATE_KEY in the environment (MAINNET.md).");

  const local = network.key === "local";
  const keeper = process.env.POLARIS_KEEPER_ADDRESS || (local ? localAccounts[1]?.address : null);
  if (!keeper) throw new Error("Set POLARIS_KEEPER_ADDRESS: the keeper EOA is the only writer to the receivers.");
  const relayer = process.env.POLARIS_RELAYER_ADDRESS || (local ? localAccounts[0]?.address : undefined);
  const treasury = process.env.POLARIS_TREASURY || deployer.address;
  const fast = process.env.POLARIS_FAST_PLANS === "1";
  const defaultSeed = { testnet: 25, mainnet: 0, local: 50_000 }[network.key];
  const poolSeed = USD(process.env.POLARIS_POOL_SEED_USDC ?? defaultSeed);
  // A testnet pool is funded from the faucet, so its floor is a few dollars;
  // mainnet keeps the $1,000 default.
  const minFreeCash = USD(process.env.POLARIS_GUARD_MIN_FREE_CASH_USDC ?? { testnet: 5, mainnet: 1_000, local: 1_000 }[network.key]);
  const minOriginated = network.key === "testnet" ? USD(1_000) : undefined;

  const keyDir = path.join(__dirname, "..", "deployments", ".keys");
  let demoMerchant;
  if (process.env.POLARIS_DEMO_MERCHANT_KEY) {
    demoMerchant = new Wallet(process.env.POLARIS_DEMO_MERCHANT_KEY);
  } else {
    demoMerchant = Wallet.createRandom();
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(keyDir, `${network.key}.demo-merchant.key`), demoMerchant.privateKey + "\n", { mode: 0o600 });
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Polaris -> ${network.name} (chain ${network.chainId})`);
  console.log(`  deployer ${deployer.address}  (${hre.ethers.formatUnits(balance, 18)} USDC for gas)`);
  console.log(`  keeper   ${getAddress(keeper)}`);
  console.log(`  relayer  ${relayer ? getAddress(relayer) : "(none)"}`);
  if (balance === 0n) throw new Error("The deployer has no USDC for gas on this network: fund it first (https://faucet.circle.com for testnet).");

  const record = await deployPolaris(
    hre,
    {
      network,
      tokenMode: local ? "mock" : "arc",
      treasury,
      keeper,
      relayer,
      graceSeconds: fast ? 15 * 60 : 3 * 24 * 3600,
      minInterval: fast ? 60 : 3600,
      minPeriod: fast ? 60 : 3600,
      demoMerchant,
      poolSeed,
      guard: { minFreeCash, ...(minOriginated ? { minOriginated } : {}) },
      // Testnet orders stay small: the pool is faucet money.
      merchantCap: network.key === "testnet" ? USD(100) : undefined,
    },
    console.log
  );

  if (local) {
    // Test dollars for the local relayer and keeper, which pay "gas" in the
    // node's native coin; and a funded faucet for the demo buyer.
    const usdc = await hre.ethers.getContractAt("MockUSDC", record.contracts.USDC.address);
    await (await usdc.mint(deployer.address, USD(1_000_000))).wait();
  }

  const out = path.join(__dirname, "..", "deployments", `arc-${network.key}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nRecord: ${path.relative(process.cwd(), out)}`);
  console.log(`Gas: ${record.gas.totalUsed} units, ${record.gas.totalCostUsdc} USDC`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
