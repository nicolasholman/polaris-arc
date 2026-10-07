/**
 * Fund the credit pool with USDC from the deployer (the pool's owner and only
 * liquidity provider): POLARIS_FUND_USDC=<dollars>. Keeps 1 USDC for gas.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const tx = require("../lib/tx");
const { networkFor } = require("../lib/networks");

async function main() {
  const network = networkFor();
  if (network.key === "mainnet" && process.env.POLARIS_CONFIRM_MAINNET !== "yes") throw new Error("Set POLARIS_CONFIRM_MAINNET=yes.");
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `arc-${network.key}.json`), "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  const amount = hre.ethers.parseUnits(process.env.POLARIS_FUND_USDC || "0", 6);
  if (amount === 0n) throw new Error("Set POLARIS_FUND_USDC to the dollars to add.");
  const usdc = await hre.ethers.getContractAt("MockUSDC", record.contracts.USDC.address, deployer);
  const engine = await hre.ethers.getContractAt("PolarisLoanEngine", record.contracts.PolarisLoanEngine.address, deployer);
  const held = await usdc.balanceOf(deployer.address);
  if (held < amount + 1_000_000n) throw new Error(`The deployer holds ${hre.ethers.formatUnits(held, 6)} USDC: not enough to add ${process.env.POLARIS_FUND_USDC} and keep 1 for gas.`);
  const r1 = await tx.send(usdc, "approve", [record.contracts.PolarisLoanEngine.address, amount]);
  const r2 = await tx.send(engine, "fund", [amount]);
  console.log(`Funded ${process.env.POLARIS_FUND_USDC} USDC: approve ${r1.hash}, fund ${r2.hash}`);
  console.log(`Free cash now ${hre.ethers.formatUnits((await engine.poolState()).freeCash, 6)} USDC`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
