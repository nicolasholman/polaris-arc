/**
 * Verify every contract in deployments/monad-testnet.json on Monadscan, through
 * the Etherscan V2 API (Monad testnet, chainid 10143, is on its free tier).
 *
 *   ETHERSCAN_API_KEY=... pnpm --filter @polarispay/contracts verify:monad
 *   VERIFY_DRY_RUN=1 pnpm --filter @polarispay/contracts verify:monad    # no key: which sources and arguments reproduce each contract
 *   VERIFY_ONLY=PolarisCheckout,GuardianReceiver ...                     # submit only some of them
 *
 * The contracts: every one the record lists, and every one a redeploy
 * replaced (still on chain under its old address, so still worth reading).
 * For each (lib/verify.js):
 *
 *   - the sources that built it: today's when they reproduce the code on
 *     chain, else those of the commit the record names for it
 *     (`sourceCommit`, per contract, per replaced contract, or for the whole
 *     record), rebuilt from git and checked to reproduce the code first. So a
 *     contract fixed in code since it was deployed (PolarisCheckout's
 *     reauthorize) still verifies as what is on chain, and one whose
 *     comments alone changed (CollectionsReceiver's NatSpec) shows the text
 *     deployed, as an exact match;
 *   - cut down to the files it is built from, when those alone still
 *     reproduce it (what the explorer shows);
 *   - its constructor arguments, read from its creation transaction (the
 *     input past its creation code) and checked against the record's `args`;
 *
 * then submits it as standard JSON through lib/monadscan.js, which puts
 * `chainid` on every call, and waits for the answer. Already verified
 * contracts are reported and skipped. Last, it asks the explorer about every
 * contract (getsourcecode) and writes deployments/monad-testnet.verification.json.
 * Reads the chain; sends no transaction.
 */

"use strict";

const { writeFileSync } = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const d = require("../deployments/monad-testnet.json");
const { verificationTargets, verificationInput, argsFromCreation } = require("../lib/verify");
const { monadscan, verificationRecord } = require("../lib/monadscan");

const OUT = path.join(__dirname, "..", "deployments", "monad-testnet.verification.json");

/** The artifact's fully qualified name ("contracts/cre/GuardianReceiver.sol:GuardianReceiver"). */
async function fqnOf(artifactName) {
  const artifact = await hre.artifacts.readArtifact(artifactName);
  return `${artifact.sourceName}:${artifact.contractName}`;
}

/**
 * The constructor arguments `target` was deployed with, from its creation
 * transaction; the record's, when it has them, must say the same.
 */
async function constructorArguments(target, found) {
  const { ethers } = hre;
  if (!target.txHash) throw new Error("the record names no creation transaction");
  const tx = await ethers.provider.getTransaction(target.txHash);
  const receipt = await ethers.provider.getTransactionReceipt(target.txHash);
  if (!tx || !receipt) throw new Error(`creation transaction ${target.txHash} not found`);
  if (tx.to !== null || ethers.getAddress(receipt.contractAddress ?? ethers.ZeroAddress) !== ethers.getAddress(target.address)) {
    throw new Error(`${target.txHash} did not create ${target.address}`);
  }
  const encoded = argsFromCreation(tx.data, found.bytecode);
  const iface = new ethers.Interface(found.abi);
  // They must decode as the constructor's parameters.
  if (iface.deploy.inputs.length > 0) ethers.AbiCoder.defaultAbiCoder().decode(iface.deploy.inputs, encoded);
  else if (encoded !== "0x") throw new Error(`the constructor takes nothing, the creation transaction passed ${encoded}`);
  if (target.args) {
    const recorded = iface.encodeDeploy(target.args);
    if (recorded.toLowerCase() !== encoded.toLowerCase()) throw new Error("the record's constructor arguments are not the ones the creation transaction passed");
  }
  return encoded;
}

async function main() {
  const dryRun = process.env.VERIFY_DRY_RUN === "1";
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!dryRun && !apiKey) throw new Error("Set ETHERSCAN_API_KEY (an Etherscan V2 key), or VERIFY_DRY_RUN=1 to only check the sources.");
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (Number(chainId) !== Number(d.chainId)) throw new Error(`The record is for chain ${d.chainId}; this network is ${chainId}.`);
  const only = process.env.VERIFY_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const explorer = dryRun ? null : monadscan({ apiKey, chainId: d.chainId });
  const targets = verificationTargets(d);
  const local = new Map();
  let failed = 0;

  for (const target of targets) {
    // Every target is rebuilt (the record below says what each was verified from); only the chosen are submitted.
    const chosen = !only || only.includes(target.name) || only.includes(target.artifact);
    const fqn = await fqnOf(target.artifact);
    const label = target.name.padEnd(29);
    try {
      const found = await verificationInput(hre, { fqn, address: target.address, commit: target.commit });
      const args = await constructorArguments(target, found);
      local.set(target.address, found);
      const from = found.from === "today" ? "today's sources" : `sources at ${found.from.slice(0, 10)}`;
      const shape = `${Object.keys(found.input.sources).length} files, ${found.exact ? "exact match" : "same executable code"}, args ${args === "0x" ? "none" : `${(args.length - 2) / 64} words`} from the creation tx`;
      if (dryRun || !chosen) {
        console.log(`${dryRun ? "ok      " : "skipped "} ${label} ${target.address}  ${from}; ${shape}`);
        continue;
      }
      if ((await explorer.sourceOf(target.address)).verified) {
        console.log(`already  ${label} ${target.address}`);
        continue;
      }
      const guid = await explorer.submit({
        address: target.address,
        input: found.input,
        contractName: fqn,
        compilerVersion: found.solcLongVersion,
        constructorArguments: args,
      });
      const status = guid === null ? "already verified" : await explorer.waitFor(guid);
      console.log(`${status === "verified" ? "verified" : "already "} ${label} ${target.address}  ${from}; ${shape}`);
    } catch (e) {
      failed++;
      console.log(`FAILED   ${label} ${target.address}: ${e.message ?? e}`);
    }
  }

  if (!dryRun) {
    const entries = [];
    for (const target of targets) {
      entries.push({ target, fqn: await fqnOf(target.artifact), explorer: await explorer.sourceOf(target.address), local: local.get(target.address) });
    }
    const out = verificationRecord({ record: d, entries, checkedAt: new Date().toISOString() });
    writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n${out.verified} of ${out.total} verified on ${out.explorer}; wrote ${path.relative(process.cwd(), OUT)}`);
    for (const c of out.contracts) console.log(`  ${c.verified ? "yes" : "NO "}  ${c.name.padEnd(29)} ${c.explorerUrl}`);
    if (out.verified !== out.total) failed++;
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
