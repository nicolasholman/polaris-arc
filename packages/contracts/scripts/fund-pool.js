/**
 * Move AUSD from the deployer into the credit pool (PolarisLoanEngine.fund).
 *
 *   pnpm --filter @polarispay/contracts fund-pool:monad            # everything the deployer holds
 *   POOL_FUND_AUSD=5000 pnpm --filter @polarispay/contracts fund-pool:monad
 *
 * For a testnet deployment on real AUSD, whose deployer held none at deploy
 * time (the Agora faucet is dry; docs/research/ausd.md section 5.2).
 */

"use strict";

const hre = require("hardhat");
const { parseUnits, formatUnits } = require("ethers");
const { send } = require("../lib/tx");
const { deploymentFile } = require("./deploy-monad");

async function main() {
  const d = require(`../deployments/${deploymentFile(hre.network.name)}`);
  const [deployer] = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("MockAUSD", d.contracts.Stablecoin.address, deployer);
  const engine = await hre.ethers.getContractAt("PolarisLoanEngine", d.contracts.PolarisLoanEngine.address, deployer);

  const held = await token.balanceOf(deployer.address);
  const amount = process.env.POOL_FUND_AUSD ? parseUnits(process.env.POOL_FUND_AUSD, 6) : held;
  if (amount === 0n || amount > held) {
    throw new Error(`The deployer holds ${formatUnits(held, 6)} AUSD; nothing to fund with.`);
  }
  await send(token, "approve", [d.contracts.PolarisLoanEngine.address, amount]);
  await send(engine, "fund", [amount]);
  console.log(`Funded the credit pool with ${formatUnits(amount, 6)} AUSD.`);
  console.log(`Pool balance ${formatUnits(await token.balanceOf(d.contracts.PolarisLoanEngine.address), 6)} AUSD.`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
