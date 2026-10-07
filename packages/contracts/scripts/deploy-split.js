/**
 * Add PolarisSplit (split the bill by link) to an existing deployment: one
 * transaction, nothing else moves.
 *
 *   pnpm --filter @polarispay/contracts deploy-split:monad   # Monad testnet: NOT run yet
 *   pnpm --filter @polarispay/contracts deploy-split:local   # a local node (monadLocal)
 *
 * A fresh `deploy:monad` or `deploy:local` already includes PolarisSplit; this
 * is for the Monad testnet deployment of 28 Sep 2026, which predates it.
 * Checks, before sending anything, that the record is this chain's, that it
 * has no PolarisSplit yet, that contracts/ is committed (the record names the
 * commit the bytecode comes from) and that the deployer holds enough MON.
 * Refuses Monad mainnet.
 *
 * Writes deployments/<network>.json (lib/split.js: contracts.PolarisSplit,
 * eip712.PolarisSplit, an `additions` entry) and appends the transaction to
 * <network>.transactions.json. Then:
 *   - restart Polaris for Business, which reads the record (its relayer, its
 *     chain sync and /api/public/network then know PolarisSplit, and the app
 *     reads the address from there; NEXT_PUBLIC_SPLIT_ADDRESS pins it);
 *   - add the address to the relayer's Privy policy
 *     (`pnpm --filter @polaris/business privy:setup-relayer -- --apply`);
 *   - `pnpm --filter @polarispay/contracts check:deployment:monad`.
 */

"use strict";

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");
const { formatEther } = require("ethers");

const { addSplit } = require("../lib/split");
const { deploymentFile } = require("./deploy-monad");

async function main() {
  const { ethers } = hre;
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId === 143n) throw new Error("Refusing Monad mainnet.");
  const file = join(__dirname, "..", "deployments", deploymentFile(hre.network.name));
  if (!existsSync(file)) throw new Error(`No deployment record at ${file}: deploy first (deploy:monad or deploy:local).`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (BigInt(record.chainId) !== chainId) throw new Error(`${file} is for chain ${record.chainId}, this network is ${chainId}`);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer key (DEPLOYER_PRIVATE_KEY).");

  const balance = await ethers.provider.getBalance(deployer.address);
  const factory = await ethers.getContractFactory("PolarisSplit", deployer);
  const deployGas = await ethers.provider.estimateGas(await factory.getDeployTransaction(record.contracts.Stablecoin.address));
  const { gasPrice, maxFeePerGas } = await ethers.provider.getFeeData();
  const price = gasPrice ?? maxFeePerGas;
  // Monad bills the gas limit; lib/tx.js sends the estimate plus 15%.
  const need = (deployGas * price * 115n) / 100n;
  console.log(`Network   ${hre.network.name} (chain ${chainId})`);
  console.log(`Deployer  ${deployer.address}`);
  console.log(`Balance   ${formatEther(balance)} MON; needs about ${formatEther(need)} at ${ethers.formatUnits(price, "gwei")} gwei`);
  console.log(`Token     ${record.contracts.Stablecoin.address}\n`);
  if (balance < need) throw new Error(`The deployer holds ${formatEther(balance)} MON; about ${formatEther(need)} is needed.`);

  const { record: next, txs } = await addSplit(hre, record, { allowDirty: process.env.ALLOW_DIRTY === "1" }, (line) => console.log(line));
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);

  const txFile = file.replace(/\.json$/, ".transactions.json");
  if (existsSync(txFile)) {
    const txLog = JSON.parse(readFileSync(txFile, "utf8"));
    if (Number(txLog.chainId) === Number(chainId)) {
      txLog.transactions.push(...txs);
      txLog.note = `${txLog.note ?? ""} Later: PolarisSplit (deploy-split), nonce ${txs[0].nonce}.`;
      writeFileSync(txFile, `${JSON.stringify(txLog, null, 2)}\n`);
    }
  }

  const spent = balance - (await ethers.provider.getBalance(deployer.address));
  console.log(`\nSpent     ${formatEther(spent)} MON`);
  console.log(`Wrote     ${file}`);
  for (const t of txs) console.log(`tx        ${t.hash}  ${t.call}${record.explorer ? `  ${record.explorer}/tx/${t.hash}` : ""}`);
  console.log(
    "\nNext: restart Polaris for Business (it reads this record), add PolarisSplit to the relayer's Privy policy " +
      "(privy:setup-relayer -- --apply), then check:deployment."
  );
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
