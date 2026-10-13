/**
 * Verify every Hardhat-built Polaris contract on Arc's Blockscout through its v2
 * standard-JSON endpoint (NETWORK=testnet | mainnet). `verify.js` goes through the
 * v1 `/api` route, which Blockscout rate limits hard (HTTP 429) for anonymous
 * callers; this one does not. It tries each compile that contains the contract until
 * the explorer accepts one. The Foundry-built CCIP / CCTP-hook receivers are not
 * covered (their build info is in Foundry's format). Sends source to the explorer only.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const key = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const explorer = key === "mainnet" ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io";
const recordFile = path.join(__dirname, "..", "deployments", `arc-${key}.json`);
const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
const infoDir = path.join(__dirname, "..", "artifacts", "build-info");
const infos = fs.readdirSync(infoDir).map((f) => JSON.parse(fs.readFileSync(path.join(infoDir, f), "utf8")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isVerified = async (address) => !!(await (await fetch(`${explorer}/api/v2/smart-contracts/${address}`)).json()).is_verified;

async function main() {
  const results = {};
  for (const [label, c] of Object.entries(record.contracts)) {
    if (!c.txHash) continue; // Circle's tokens
    if (await isVerified(c.address)) {
      results[label] = "verified";
      continue;
    }
    const name = c.contract;
    const candidates = infos.filter((bi) => Object.entries(bi.output?.contracts ?? {}).some(([s, cs]) => cs[name] && s.startsWith("contracts/") && s.endsWith(`/${name}.sol`)));
    if (candidates.length === 0) {
      results[label] = "not verified (no Hardhat build info: Foundry build)";
      continue;
    }
    let ok = false;
    for (const bi of candidates) {
      const body = new FormData();
      body.append("compiler_version", `v${bi.solcLongVersion}`);
      body.append("license_type", "mit");
      body.append("contract_name", name);
      body.append("autodetect_constructor_args", "true");
      body.append("files[0]", new Blob([JSON.stringify(bi.input)], { type: "application/json" }), "input.json");
      await fetch(`${explorer}/api/v2/smart-contracts/${c.address}/verification/via/standard-input`, { method: "POST", body });
      for (let i = 0; i < 8 && !ok; i++) {
        await sleep(6000);
        ok = await isVerified(c.address);
      }
      if (ok) break;
    }
    results[label] = ok ? "verified" : "failed";
    console.log(`  ${label.padEnd(22)} ${c.address}  ${results[label]}`);
  }
  const latest = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  latest.verification = { explorer, at: new Date().toISOString(), method: "Blockscout v2 standard-input", results };
  fs.writeFileSync(recordFile, JSON.stringify(latest, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
