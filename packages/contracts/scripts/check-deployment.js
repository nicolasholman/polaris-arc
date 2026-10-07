/**
 * Read a deployment back from its chain and check every address and role
 * against the record. Read-only: it sends nothing and needs no key.
 *
 *   pnpm --filter @polarispay/contracts check:deployment:monad            # Monad testnet
 *   pnpm --filter @polarispay/contracts check:deployment:monad -- --json  # rows as JSON
 *   pnpm --filter @polarispay/contracts check:deployment:fork             # a local fork (deploy:fork)
 *
 * Checks (lib/check.js): code at every contract and at Chainlink's forwarder;
 * the deployer owns what it should; PolarisCheckout is the loan engine's only
 * originator and the payments' checkout; the scores, the vault and the
 * registry are wired; GuardianReceiver is the checkout's credit guard with
 * the recorded thresholds; the three CRE receivers sit behind the recorded
 * forwarder with the recorded simulation transmitter (never the deployer);
 * the relayer's operator roles; PolarisSplit's token and domain, when the
 * deployment has one; the dollar's EIP-712 domain (and, for the
 * mock, that it says it is one); the demo merchant. Exit 1 if any fails.
 */

"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");
const { checkDeployment } = require("../lib/check");
const { deploymentFile } = require("./deploy-monad");

async function main() {
  const file = join(__dirname, "..", "deployments", deploymentFile(hre.network.name));
  const record = JSON.parse(readFileSync(file, "utf8"));
  const rows = await checkDeployment(hre.ethers, record);
  if (process.argv.includes("--json") || process.env.CHECK_JSON === "1") {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(`${record.network} (chain ${record.chainId}), ${file}\n`);
    for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.what}${r.detail ? `  ${r.detail}` : ""}`);
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length} of ${rows.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
