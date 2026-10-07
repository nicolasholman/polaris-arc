/**
 * Allowlist every PolarisCCIPSender in the record on the Arc receiver (the
 * receiver's owner, the deployer, runs it):
 *
 *   NETWORK=testnet npx hardhat run scripts/ccip-allow-sender.js --network arcTestnet
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
  const file = process.env.POLARIS_DEPLOYMENT_FILE || path.join(__dirname, "..", "deployments", `arc-${network.key}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "abi", "PolarisCCIPReceiver.json"), "utf8"));
  const [owner] = await hre.ethers.getSigners();
  const receiver = new hre.ethers.Contract(record.contracts.PolarisCCIPReceiver.address, abi, owner);
  for (const s of Object.values(record.ccip?.senders ?? {})) {
    if (await receiver.allowedSenders(s.selector, s.address)) {
      console.log(`${s.name} ${s.address}: already allowed`);
      continue;
    }
    const r = await tx.send(receiver, "allowSender", [s.selector, s.address, true]);
    s.allowedTx = r.hash;
    console.log(`${s.name} ${s.address}: allowed (${r.hash})`);
  }
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
