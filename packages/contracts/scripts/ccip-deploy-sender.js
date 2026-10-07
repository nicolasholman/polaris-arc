/**
 * Deploy PolarisCCIPSender on a CCIP source chain, pointed at the Arc
 * receiver in the deployment record. User-run (it broadcasts on the source
 * chain with your key):
 *
 *   NETWORK=testnet npx hardhat run scripts/ccip-deploy-sender.js --network baseSepolia
 *   NETWORK=testnet npx hardhat run scripts/ccip-allow-sender.js --network arcTestnet   # then allowlist it on Arc
 *
 * Mainnet sources (`--network base|ethereum`, NETWORK=mainnet) need
 * POLARIS_CONFIRM_MAINNET=yes. The sender is ownerless and immutable: it can
 * only send to the one Arc receiver it was built for.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const hre = require("hardhat");
const tx = require("../lib/tx");
const { networkFor } = require("../lib/networks");

async function main() {
  const network = networkFor();
  if (network.key === "mainnet" && process.env.POLARIS_CONFIRM_MAINNET !== "yes") throw new Error("Set POLARIS_CONFIRM_MAINNET=yes for a mainnet source chain.");
  const file = process.env.POLARIS_DEPLOYMENT_FILE || path.join(__dirname, "..", "deployments", `arc-${network.key}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const receiver = record.contracts.PolarisCCIPReceiver?.address;
  if (!receiver) throw new Error(`${file} has no PolarisCCIPReceiver: deploy Polaris on Arc first.`);
  const { chainId } = await hre.ethers.provider.getNetwork();
  const source = network.ccip.sources.find((s) => s.chainId === Number(chainId));
  if (!source) throw new Error(`Chain ${chainId} isn't a Polaris CCIP source for Arc ${network.key} (lib/networks.js).`);

  const artFile = path.join(__dirname, "..", "ccip", "out", "PolarisCCIPSender.sol", "PolarisCCIPSender.json");
  if (!fs.existsSync(artFile)) execFileSync("forge", ["build"], { cwd: path.join(__dirname, ".."), stdio: "inherit" });
  const art = JSON.parse(fs.readFileSync(artFile, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  const args = [source.router, source.usdc, source.tokenMessengerV2, network.ccip.chainSelector, network.circle.cctpDomain, receiver, 600_000];
  const factory = new hre.ethers.ContractFactory(art.abi, art.bytecode.object, deployer);
  const d = await tx.deploy(factory, args);
  console.log(`PolarisCCIPSender on ${source.name}: ${d.address} (tx ${d.receipt.hash})`);
  record.ccip = record.ccip ?? {};
  record.ccip.senders = { ...(record.ccip.senders ?? {}), [source.chainId]: { name: source.name, selector: source.selector, address: d.address, txHash: d.receipt.hash, args: args.map(String) } };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Recorded in ${path.relative(process.cwd(), file)}. Next: allowlist it on Arc (scripts/ccip-allow-sender.js).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
