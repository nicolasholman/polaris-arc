/**
 * Fill the credit pool of a fork deployment with real AUSD from Agora's
 * faucet, as it stands on Monad testnet, then PolarisLoanEngine.fund.
 *
 *   pnpm --filter @polarispay/contracts fund-pool:fork                       # the record's pool target (10,000)
 *   POOL_FUND_AUSD=20000 pnpm --filter @polarispay/contracts fund-pool:fork
 *
 * Fork only (lib/fork.js refuses any other node): it asks the faucet for the
 * deployer, moving the fork's clock past the faucet's 60-second cooldown
 * between drips, so it would be wrong anywhere real. Reads and writes nothing
 * but deployments/monad-fork.json's chain.
 */

"use strict";

const hre = require("hardhat");
const { parseUnits, formatUnits } = require("ethers");
const { send } = require("../lib/tx");
const { requireForkNode, dripUntil } = require("../lib/fork");
const { deploymentFile, FORK_NETWORKS } = require("./deploy-monad");

async function main() {
  if (!FORK_NETWORKS.has(hre.network.name)) throw new Error("fund-pool:fork runs on --network monadFork only.");
  await requireForkNode(hre.ethers.provider);
  const d = require(`../deployments/${deploymentFile(hre.network.name)}`);
  if (d.contracts.Stablecoin.kind !== "AUSD") throw new Error("This fork deployment is not on real AUSD (AUSD_MODE=ausd).");

  const [deployer] = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("MockAUSD", d.contracts.Stablecoin.address, deployer);
  const engine = await hre.ethers.getContractAt("PolarisLoanEngine", d.contracts.PolarisLoanEngine.address, deployer);

  const amount = process.env.POOL_FUND_AUSD ? parseUnits(process.env.POOL_FUND_AUSD, 6) : BigInt(d.demo.poolTarget);
  const before = await token.balanceOf(deployer.address);
  const drips = await dripUntil({
    provider: hre.ethers.provider,
    signer: deployer,
    token,
    to: deployer.address,
    target: amount,
    log: (line) => console.log(line),
  });
  console.log(`Deployer holds ${formatUnits(await token.balanceOf(deployer.address), 6)} AUSD (${drips} faucet drips, ${formatUnits(before, 6)} before).`);

  await send(token, "approve", [d.contracts.PolarisLoanEngine.address, amount]);
  await send(engine, "fund", [amount]);
  console.log(`Funded the credit pool with ${formatUnits(amount, 6)} real AUSD.`);
  console.log(`Pool balance ${formatUnits(await token.balanceOf(d.contracts.PolarisLoanEngine.address), 6)} AUSD.`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
