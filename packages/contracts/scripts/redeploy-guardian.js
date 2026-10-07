/**
 * Replace the deployment's GuardianReceiver with today's code, and point
 * PolarisCheckout's credit guard at it. Nothing else moves: every other
 * address, the apps' and the indexer's configuration, stays as it is.
 *
 *   pnpm --filter @polarispay/contracts redeploy-guardian:monad
 *   REDEPLOY_WHY="..." GUARD_MIN_PRICE=... pnpm … redeploy-guardian:monad
 *
 * The thresholds come from GUARD_* like deploy:monad's (lib/cre.js defaults
 * for any unset). Checks the deployer owns PolarisCheckout, that the old
 * receiver is not already today's code, that contracts/ is committed (the
 * record names the commit the bytecode comes from), and that the deployer
 * holds enough MON, before sending anything. Refuses Monad mainnet.
 *
 * Writes deployments/<network>.json (lib/redeploy.js: the new receiver, the
 * guardian workflow's receiver and view, config.guardian, a `redeploys`
 * entry) and appends the two transactions to <network>.transactions.json.
 * Then run `configure staging` in workflows/ and check:deployment:monad.
 */

"use strict";

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");
const { formatEther } = require("ethers");

const { guardianThresholds } = require("../lib/cre");
const { redeployGuardian } = require("../lib/redeploy");
const { deploymentFile, guardianConfig } = require("./deploy-monad");

async function main() {
  const { ethers } = hre;
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId === 143n) throw new Error("Refusing Monad mainnet: Polaris credit stays on testnet.");
  const file = join(__dirname, "..", "deployments", deploymentFile(hre.network.name));
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (BigInt(record.chainId) !== chainId) throw new Error(`${file} is for chain ${record.chainId}, this network is ${chainId}`);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer key (DEPLOYER_PRIVATE_KEY).");
  const cfg = guardianConfig(process.env);

  const balance = await ethers.provider.getBalance(deployer.address);
  const factory = await ethers.getContractFactory("GuardianReceiver", deployer);
  const args = [
    record.cre.forwarder,
    record.contracts.PolarisLoanEngine.address,
    record.cre.simulationTransmitter ?? ethers.ZeroAddress,
    guardianThresholds(cfg.guardianThresholds),
    cfg.maxAttestationAge,
  ];
  const deployGas = await ethers.provider.estimateGas(await factory.getDeployTransaction(...args));
  const { gasPrice, maxFeePerGas } = await ethers.provider.getFeeData();
  const price = gasPrice ?? maxFeePerGas;
  // Monad bills the gas limit; lib/tx.js sends the estimate plus 15%.
  const need = ((deployGas + 60_000n) * price * 115n) / 100n;
  console.log(`Network   ${hre.network.name} (chain ${chainId})`);
  console.log(`Deployer  ${deployer.address}`);
  console.log(`Balance   ${formatEther(balance)} MON; needs about ${formatEther(need)} at ${ethers.formatUnits(price, "gwei")} gwei`);
  console.log(`Replacing GuardianReceiver ${record.contracts.GuardianReceiver.address}\n`);
  if (balance < need) throw new Error(`The deployer holds ${formatEther(balance)} MON; about ${formatEther(need)} is needed.`);

  const { record: next, txs } = await redeployGuardian(
    hre,
    record,
    { thresholds: cfg.guardianThresholds, maxAttestationAge: cfg.maxAttestationAge, why: process.env.REDEPLOY_WHY || null },
    (line) => console.log(line)
  );
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);

  const txFile = file.replace(/\.json$/, ".transactions.json");
  if (existsSync(txFile)) {
    const log = JSON.parse(readFileSync(txFile, "utf8"));
    if (Number(log.chainId) === Number(chainId)) {
      log.transactions.push(...txs);
      log.note = `${log.note.replace(/ Later: .*$/, "")} Later: the GuardianReceiver redeploy (redeploy-guardian:monad), nonces ${txs[0].nonce}-${txs[txs.length - 1].nonce}.`;
      writeFileSync(txFile, `${JSON.stringify(log, null, 2)}\n`);
    }
  }

  const spent = balance - (await ethers.provider.getBalance(deployer.address));
  console.log(`\nSpent     ${formatEther(spent)} MON`);
  console.log(`Wrote     ${file}`);
  for (const t of txs) console.log(`tx        ${t.hash}  ${t.contract} ${t.call}${record.explorer ? `  ${record.explorer}/tx/${t.hash}` : ""}`);
  console.log("\nNext: `pnpm --filter @polaris/cre-workflows configure staging`, then `pnpm --filter @polarispay/contracts check:deployment:monad`.");
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
