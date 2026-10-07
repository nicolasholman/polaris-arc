/**
 * Lock the CRE receivers on Monad testnet to the deployed Polaris workflows:
 *
 *   CRE_WORKFLOW_OWNER=0x… \
 *   CRE_WORKFLOW_ID_COLLECTIONS=0x… CRE_WORKFLOW_ID_UNDERWRITE=0x… CRE_WORKFLOW_ID_GUARDIAN=0x… \
 *   pnpm --filter @polarispay/contracts lock-receivers:monad
 *
 * Run it after `cre workflow deploy`, which prints each workflow's id. For each
 * receiver given an id it sets, in this order and only where different:
 * setExpectedAuthor(owner), setExpectedWorkflowName(name),
 * setExpectedWorkflowId(id); then, with CRE_FORWARDER=production (the
 * default), setForwarderAddress(the KeystoneForwarder) and
 * setSimulationTransmitter(0). With CRE_FORWARDER=simulation it keeps
 * Chainlink's simulation forwarder and the transmitter guard, and only adds the
 * identity checks (for runs of `cre workflow simulate --broadcast` whose
 * metadata carries those values).
 *
 * Environment:
 *   CRE_WORKFLOW_OWNER            the workflow owner (required)
 *   CRE_WORKFLOW_ID_COLLECTIONS   polaris-collections' id  (each optional;
 *   CRE_WORKFLOW_ID_UNDERWRITE    polaris-underwrite's id   a receiver without
 *   CRE_WORKFLOW_ID_GUARDIAN      polaris-guardian's id     one is untouched)
 *   CRE_FORWARDER                 "production" (default) or "simulation"
 *   CRE_FORWARDER_ADDRESS         overrides the production forwarder, on a local
 *                                 chain only (refused on Monad testnet)
 *
 * The production forwarder must answer typeAndVersion() as Chainlink's
 * KeystoneForwarder does. Chainlink's MockKeystoneForwarder (the simulation
 * forwarder, which anyone can call) is refused, and then nothing is sent.
 *
 * Writes the result into the deployment record's `cre.locked`, and each
 * workflow's `workflowId`. Refuses Monad mainnet.
 */

"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

const { MONAD_TESTNET } = require("../lib/deploy");
const { RECEIVERS, lockReceivers, applyLock, isLocalNetwork } = require("../lib/lock");
const { deploymentFile } = require("./deploy-monad");

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId === 143n) throw new Error("Refusing Monad mainnet: Polaris credit stays on testnet.");
  const env = process.env;
  const file = join(__dirname, "..", "deployments", deploymentFile(hre.network.name));
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (BigInt(record.chainId) !== chainId) throw new Error(`${file} is for chain ${record.chainId}, this network is ${chainId}`);

  const forwarderKind = env.CRE_FORWARDER || "production";
  if (env.CRE_FORWARDER_ADDRESS && !isLocalNetwork(hre)) {
    throw new Error(
      `CRE_FORWARDER_ADDRESS is for a local chain; on ${hre.network.name} the production forwarder is Chainlink's KeystoneForwarder (${MONAD_TESTNET.CRE_KEYSTONE_FORWARDER}).`
    );
  }
  const workflowIds = Object.fromEntries(RECEIVERS.filter((r) => env[r.idEnv]).map((r) => [r.contract, env[r.idEnv]]));
  const missing = RECEIVERS.filter((r) => !env[r.idEnv]).map((r) => r.idEnv);

  console.log(`Network   ${hre.network.name} (chain ${chainId})`);
  console.log(`Owner     ${env.CRE_WORKFLOW_OWNER ?? "(missing)"}`);
  console.log(`Forwarder ${forwarderKind}${forwarderKind === "production" ? ` ${env.CRE_FORWARDER_ADDRESS || MONAD_TESTNET.CRE_KEYSTONE_FORWARDER}` : " (kept)"}`);
  if (missing.length) console.log(`Skipping  ${missing.join(", ")} not set: those receivers are left as they are`);
  console.log("");

  const lock = await lockReceivers(
    hre,
    record,
    {
      workflowOwner: env.CRE_WORKFLOW_OWNER,
      workflowIds,
      forwarderKind,
      forwarderAddress: env.CRE_FORWARDER_ADDRESS || MONAD_TESTNET.CRE_KEYSTONE_FORWARDER,
    },
    (line) => console.log(line)
  );
  applyLock(record, lock);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nWrote     ${file} (cre.locked)`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
