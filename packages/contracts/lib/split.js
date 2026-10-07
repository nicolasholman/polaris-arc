/**
 * Add PolarisSplit (split the bill by link) to a live deployment that
 * predates it, without moving anything else. Used by scripts/deploy-split.js
 * (`deploy-split:monad`, `deploy-split:local`) and test/metropolis/
 * DeploySplit.test.js.
 *
 * PolarisSplit has no owner, no roles and no custody: its one constructor
 * argument is the deployment's stablecoin, and no other contract calls it.
 * So adding it is one transaction, and nothing already deployed changes. A
 * fresh deployment (lib/deploy.js) includes it from the start.
 *
 * Folds the result into the record: `contracts.PolarisSplit` (with the
 * commit its bytecode was built from), `eip712.PolarisSplit` (the domain read
 * back from the chain, and the struct types), and an `additions` entry.
 * Refuses, before sending anything, a record that already has a PolarisSplit
 * with code, or one without a stablecoin.
 */

"use strict";

const tx = require("./tx");
const { jsonSafe } = require("./deploy");
const { TYPES, readDomain, domainJson } = require("./eip712");
const { headSource } = require("./verify");

/**
 * @param {object} hre
 * @param {object} record  a deployment record (deployments/*.json); not mutated
 * @param {object} [opts]
 * @param {boolean} [opts.allowDirty]  allow uncommitted contracts (tests); the record then says so
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ record: object, txs: object[] }>}
 */
async function addSplit(hre, record, opts = {}, log = () => {}) {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const token = record.contracts?.Stablecoin?.address;
  if (!token) throw new Error("the record has no Stablecoin");
  const existing = record.contracts?.PolarisSplit?.address;
  if (existing && (await ethers.provider.getCode(existing)) !== "0x") {
    throw new Error(`PolarisSplit is already deployed at ${existing}`);
  }
  const source = headSource();
  if (source.dirty && !opts.allowDirty) {
    throw new Error("contracts/ has uncommitted changes: commit them first, so the record can name the commit this bytecode comes from");
  }

  log("PolarisSplit");
  const factory = await ethers.getContractFactory("PolarisSplit", deployer);
  const args = [token];
  const d = await tx.deploy(factory, args);
  const sent = await ethers.provider.getTransaction(d.receipt.hash);
  const txs = [{ nonce: sent.nonce, block: d.receipt.blockNumber, hash: d.receipt.hash, contract: "create", call: "deploy PolarisSplit" }];
  log(`  PolarisSplit           ${d.address}  (block ${d.receipt.blockNumber}, gas ${d.receipt.gasUsed})`);

  const next = JSON.parse(JSON.stringify(record));
  next.contracts.PolarisSplit = {
    address: d.address,
    blockNumber: d.receipt.blockNumber,
    txHash: d.receipt.hash,
    gasUsed: d.receipt.gasUsed.toString(),
    abi: "abi/PolarisSplit.json",
    args: jsonSafe(args),
    sourceCommit: source.commit,
    ...(source.dirty ? { sourceDirty: true } : {}),
  };
  next.eip712 = {
    ...(next.eip712 ?? {}),
    PolarisSplit: { domain: domainJson(await readDomain(d.contract)), types: TYPES.PolarisSplit },
  };
  next.additions = [
    ...(next.additions ?? []),
    { at: new Date().toISOString(), contract: "PolarisSplit", address: d.address, sourceCommit: source.commit, txs },
  ];
  return { record: next, txs };
}

module.exports = { addSplit };
