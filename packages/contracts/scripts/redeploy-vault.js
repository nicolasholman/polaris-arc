/**
 * Replace the deployment's CollateralVault with today's, which takes
 * `lockWithPermit` and `withdrawWithSig`: a borrower securing a Pay in 4 line
 * signs an ERC-2612 permit, and taking it out again signs an EIP-712
 * Withdraw; the relayer carries both, so they never need MON. ScoreManager and
 * the loan engine are pointed at it; every other address, and the apps', the
 * indexer's and the workflows' configuration, stays as it is (the vault's
 * address is in the SDK presets and the indexer config: update those after).
 * The record gains `eip712.CollateralVault`. Collateral locked in the old
 * vault stays there, withdrawable only by its owner's own transaction
 * (docs/DEPLOY-LATER.md).
 *
 *   pnpm --filter @polarispay/contracts redeploy-vault:monad
 *   REDEPLOY_WHY="..." pnpm --filter @polarispay/contracts redeploy-vault:monad
 *
 * Checks the deployer owns ScoreManager and the loan engine, that the old
 * vault is not already today's code, that contracts/ is committed (the record
 * names the commit the bytecode comes from), and that the deployer holds
 * enough MON, before sending anything. Refuses Monad mainnet.
 *
 * Writes deployments/<network>.json (lib/redeploy.js: the new vault and a
 * `redeploys` entry) and appends the transactions to
 * <network>.transactions.json. Then run check:deployment:monad.
 */

"use strict";

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");
const { formatEther } = require("ethers");

const { redeployVault } = require("../lib/redeploy");
const { deploymentFile } = require("./deploy-monad");

async function main() {
  const { ethers } = hre;
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId === 143n) throw new Error("Refusing Monad mainnet: Polaris credit stays on testnet.");
  const file = join(__dirname, "..", "deployments", deploymentFile(hre.network.name));
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (BigInt(record.chainId) !== chainId) throw new Error(`${file} is for chain ${record.chainId}, this network is ${chainId}`);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer key (DEPLOYER_PRIVATE_KEY).");

  const balance = await ethers.provider.getBalance(deployer.address);
  const factory = await ethers.getContractFactory("CollateralVault", deployer);
  const deployGas = await ethers.provider.estimateGas(
    await factory.getDeployTransaction(deployer.address, record.contracts.Stablecoin.address)
  );
  const { gasPrice, maxFeePerGas } = await ethers.provider.getFeeData();
  const price = gasPrice ?? maxFeePerGas;
  // Monad bills the gas limit; lib/tx.js sends the estimate plus 15%. Four wiring calls after the deploy.
  const need = ((deployGas + 4n * 60_000n) * price * 115n) / 100n;
  console.log(`Network   ${hre.network.name} (chain ${chainId})`);
  console.log(`Deployer  ${deployer.address}`);
  console.log(`Balance   ${formatEther(balance)} MON; needs about ${formatEther(need)} at ${ethers.formatUnits(price, "gwei")} gwei`);
  console.log(`Replacing CollateralVault ${record.contracts.CollateralVault.address}\n`);
  if (balance < need) throw new Error(`The deployer holds ${formatEther(balance)} MON; about ${formatEther(need)} is needed.`);

  const { record: next, txs } = await redeployVault(hre, record, { why: process.env.REDEPLOY_WHY || null }, (line) => console.log(line));
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);

  const txFile = file.replace(/\.json$/, ".transactions.json");
  if (existsSync(txFile)) {
    const log = JSON.parse(readFileSync(txFile, "utf8"));
    if (Number(log.chainId) === Number(chainId)) {
      log.transactions.push(...txs);
      log.note = `${log.note} Later: the CollateralVault redeploy (redeploy-vault:monad), nonces ${txs[0].nonce}-${txs[txs.length - 1].nonce}.`;
      writeFileSync(txFile, `${JSON.stringify(log, null, 2)}\n`);
    }
  }

  const spent = balance - (await ethers.provider.getBalance(deployer.address));
  console.log(`\nSpent     ${formatEther(spent)} MON`);
  console.log(`Wrote     ${file}`);
  for (const t of txs) console.log(`tx        ${t.hash}  ${t.contract} ${t.call}${record.explorer ? `  ${record.explorer}/tx/${t.hash}` : ""}`);
  console.log("\nNext: `pnpm --filter @polarispay/contracts check:deployment:monad`, and the vault address in packages/sdk and packages/indexer.");
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
