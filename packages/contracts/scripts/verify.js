/**
 * Verify every Polaris contract in deployments/arc-<network>.json on Arc's
 * Blockscout explorer (NETWORK=testnet | mainnet). Read-only on chain; it
 * sends source to the explorer, nothing to the chain. Contracts already
 * verified are reported and skipped.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { networkFor } = require("../lib/networks");

async function main() {
  const network = networkFor();
  const file = path.join(__dirname, "..", "deployments", `arc-${network.key}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const results = {};
  for (const [label, c] of Object.entries(record.contracts)) {
    if (!c.txHash) continue; // Circle's tokens: not ours
    const fqn = c.contract === "MockUSDC" ? "contracts/MockUSDC.sol:MockUSDC" : undefined;
    // Blockscout rate limits anonymous callers (HTTP 429): pace the requests and retry a few times.
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await hre.run("verify:verify", { address: c.address, constructorArguments: c.args ?? [], ...(fqn ? { contract: fqn } : {}) });
        results[label] = "verified";
        break;
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/already verified/i.test(msg)) {
          results[label] = "already verified";
          break;
        }
        results[label] = `failed: ${msg.split("\n")[0]}`;
        if (attempt < 5) await new Promise((r) => setTimeout(r, 15_000 * attempt));
      }
    }
    await new Promise((r) => setTimeout(r, 6_000));
    console.log(`  ${label.padEnd(22)} ${c.address}  ${results[label]}`);
  }
  record.verification = { explorer: network.explorerUrl, at: new Date().toISOString(), results };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
