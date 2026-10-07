/**
 * Read or configure the deployed credit guard (GuardianReceiver):
 *
 *   pnpm --filter @polarispay/contracts guardian:monad                                     # status
 *   GUARD_ACTION=thresholds GUARD_MIN_PRICE=1.001 pnpm … guardian:monad                   # the demo's raised peg (decision 28)
 *   GUARD_ACTION=thresholds pnpm … guardian:monad                                         # back to decision 9's thresholds
 *   GUARD_ACTION=override GUARD_OVERRIDE=pause|none pnpm … guardian:monad
 *   GUARD_ACTION=override GUARD_OVERRIDE=resume GUARD_RESUME_SECONDS=3600 pnpm … guardian:monad   # ends by itself (at most a day)
 *   GUARD_ACTION=acknowledge pnpm … guardian:monad                                        # only bad debt beyond today's counts
 *   GUARD_ACTION=max-age GUARD_MAX_ATTESTATION_AGE_SECONDS=1800 pnpm … guardian:monad
 *
 * Reads deployments/<network>.json. Changes are sent by the receiver's owner
 * (DEPLOYER_PRIVATE_KEY) with an estimated gas limit (lib/tx.js). Prints the
 * guard's status after any change. Refuses Monad mainnet.
 */

"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

const { guardianStatus, runGuardianAction } = require("../lib/guardian");
const { deploymentFile, guardianConfig } = require("./deploy-monad");

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId === 143n) throw new Error("Refusing Monad mainnet.");
  const record = JSON.parse(readFileSync(join(__dirname, "..", "deployments", deploymentFile(hre.network.name)), "utf8"));
  const address = record.contracts.GuardianReceiver?.address;
  if (!address) throw new Error("This deployment has no GuardianReceiver.");
  const action = process.env.GUARD_ACTION || "status";
  const [owner] = await hre.ethers.getSigners();
  const guardian = await hre.ethers.getContractAt("GuardianReceiver", address, owner);

  const { sent } = await runGuardianAction(guardian, action, {
    config: guardianConfig(process.env),
    override: process.env.GUARD_OVERRIDE,
    resumeSeconds: process.env.GUARD_RESUME_SECONDS || undefined,
  });
  if (sent) console.log(`${action}: ${sent}${record.explorer ? `  ${record.explorer}/tx/${sent}` : ""}`);
  console.log(JSON.stringify(await guardianStatus(guardian), null, 2));
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
