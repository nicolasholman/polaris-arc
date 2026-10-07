/**
 * Replace one contract of a live deployment, touching nothing else:
 *
 * - GuardianReceiver (`redeployGuardian`): only PolarisCheckout's credit
 *   guard moves (scripts/redeploy-guardian.js, `redeploy-guardian:monad`;
 *   test/metropolis/Redeploy.test.js);
 * - CollateralVault (`redeployVault`): only ScoreManager's and the loan
 *   engine's vault pointers move (scripts/redeploy-vault.js,
 *   `redeploy-vault:monad`; test/metropolis/RedeployVault.test.js). Today's
 *   vault takes `lockWithPermit` and `withdrawWithSig`, so a borrower
 *   securing a line, and taking the collateral out again, needs no MON.
 *
 * For the guardian: it deploys the current GuardianReceiver against the record's own loan
 * engine, forwarder and simulation transmitter, points PolarisCheckout at it
 * (setCreditGuardian), and folds the result into the record: the contract's
 * entry (with the commit it was built from), roles.creditGuardian, the
 * guardian workflow's receiver, feed and view, config.guardian, and a
 * `redeploys` entry naming what it replaced. The old receiver stays on chain
 * with its rounds; nothing asks it any more.
 *
 * Refuses before sending anything when the signer is not the owner of
 * PolarisCheckout, or when the record's GuardianReceiver already runs today's
 * code (nothing to replace).
 */

"use strict";

const { getAddress } = require("ethers");

const tx = require("./tx");
const { guardianThresholds } = require("./cre");
const { GUARDIAN_VIEW, guardianRecordConfig, jsonSafe } = require("./deploy");
const { TYPES, readDomain, domainJson } = require("./eip712");
const { headSource, sameExecutable } = require("./verify");

const FQN = "contracts/cre/GuardianReceiver.sol:GuardianReceiver";

const VAULT_FQN = "contracts/CollateralVault.sol:CollateralVault";

/** Whether the code at `address` is today's build of `fqn` ("path.sol:Name"). */
async function runsTodays(hre, fqn, address) {
  const [path, name] = fqn.split(":");
  const artifact = await hre.artifacts.readArtifact(fqn);
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  const refs = buildInfo?.output?.contracts?.[path]?.[name]?.evm?.deployedBytecode?.immutableReferences;
  return sameExecutable(await hre.ethers.provider.getCode(address), artifact.deployedBytecode, refs);
}

/** Whether the code at `address` is today's GuardianReceiver. */
async function runsTodaysGuardian(hre, address) {
  return runsTodays(hre, FQN, address);
}

/** Whether the code at `address` is today's CollateralVault. */
async function runsTodaysVault(hre, address) {
  return runsTodays(hre, VAULT_FQN, address);
}

/**
 * @param {object} hre
 * @param {object} record   a deployment record (deployments/*.json); not mutated
 * @param {object} [opts]
 * @param {object} [opts.thresholds]        GuardianReceiver thresholds (lib/cre.js defaults for any unset)
 * @param {number} [opts.maxAttestationAge] seconds (the record's, else 3600)
 * @param {string} [opts.why]               kept in the record's `redeploys` entry
 * @param {boolean} [opts.allowDirty]       allow uncommitted contracts (tests); the record then says so
 * @returns {Promise<{ record: object, txs: object[] }>}
 */
async function redeployGuardian(hre, record, opts = {}, log = () => {}) {
  const { ethers } = hre;
  const [owner] = await ethers.getSigners();
  const old = record.contracts?.GuardianReceiver;
  const engine = record.contracts?.PolarisLoanEngine?.address;
  const checkoutAddress = record.contracts?.PolarisCheckout?.address;
  if (!old || !engine || !checkoutAddress) throw new Error("the record has no GuardianReceiver, PolarisLoanEngine or PolarisCheckout");
  const checkout = await ethers.getContractAt("PolarisCheckout", checkoutAddress, owner);
  const checkoutOwner = await checkout.owner();
  if (getAddress(checkoutOwner) !== owner.address) throw new Error(`PolarisCheckout is owned by ${checkoutOwner}, not the signer ${owner.address}`);
  if (await runsTodaysGuardian(hre, old.address)) throw new Error(`GuardianReceiver ${old.address} already runs today's code: nothing to replace`);
  const source = headSource();
  if (source.dirty && !opts.allowDirty) throw new Error("contracts/ has uncommitted changes: commit them first, so the record can name the commit this bytecode comes from");

  const forwarder = record.cre?.forwarder;
  const transmitter = record.cre?.simulationTransmitter ?? ethers.ZeroAddress;
  if (!forwarder) throw new Error("the record names no CRE forwarder");
  const thresholds = guardianThresholds(opts.thresholds ?? {});
  const maxAttestationAge = Number(opts.maxAttestationAge ?? record.config?.guardian?.maxAttestationAge ?? 3600);
  const args = [forwarder, engine, transmitter, thresholds, maxAttestationAge];

  const txs = [];
  const note = async (receipt, contract, call) => {
    const sent = await ethers.provider.getTransaction(receipt.hash);
    txs.push({ nonce: sent.nonce, block: receipt.blockNumber, hash: receipt.hash, contract, call });
  };

  log("GuardianReceiver (today's code)");
  const factory = await ethers.getContractFactory("GuardianReceiver", owner);
  const d = await tx.deploy(factory, args);
  await note(d.receipt, "create", "deploy");
  log(`  GuardianReceiver       ${d.address}  (block ${d.receipt.blockNumber}, gas ${d.receipt.gasUsed})`);
  const wired = await tx.send(checkout, "setCreditGuardian", [d.address]);
  await note(wired, "PolarisCheckout", `setCreditGuardian(${d.address})`);
  log(`  PolarisCheckout: credit guardian = ${d.address}  (${wired.hash})`);

  const next = JSON.parse(JSON.stringify(record));
  next.contracts.GuardianReceiver = {
    address: d.address,
    blockNumber: d.receipt.blockNumber,
    txHash: d.receipt.hash,
    gasUsed: d.receipt.gasUsed.toString(),
    abi: "abi/GuardianReceiver.json",
    args: jsonSafe(args),
    sourceCommit: source.commit,
    ...(source.dirty ? { sourceDirty: true } : {}),
  };
  next.roles = { ...next.roles, creditGuardian: d.address };
  next.config = { ...next.config, guardian: guardianRecordConfig(thresholds, maxAttestationAge) };
  const g = next.cre?.workflows?.guardian;
  if (g) {
    g.receiver = d.address;
    g.view = GUARDIAN_VIEW;
    if (g.feed) g.feed.address = d.address;
  }
  next.redeploys = [
    ...(next.redeploys ?? []),
    {
      at: new Date().toISOString(),
      contract: "GuardianReceiver",
      replaced: { address: old.address, txHash: old.txHash, sourceCommit: old.sourceCommit ?? record.sourceCommit ?? null },
      address: d.address,
      sourceCommit: source.commit,
      why: opts.why ?? null,
      txs,
    },
  ];
  return { record: next, txs };
}

/**
 * Replace the record's CollateralVault with today's (which takes
 * `lockWithPermit` and `withdrawWithSig`) and point ScoreManager and the loan
 * engine at it. The new vault gets the old one's multiplier, the loan engine
 * as its engine and seizer, and the same owner; the record gains its EIP-712
 * domain and `Withdraw` type (`eip712.CollateralVault`), which is how the
 * relayer and the app tell a vault that takes signed withdrawals. Nothing
 * locked in the old vault moves: it stays on chain, and whoever locked in it
 * can still `withdraw` it there with their own transaction (it still asks the
 * loan engine for their debt), but it no longer raises a limit, a liquidation
 * no longer seizes from it, and the relayer can't take it out for them.
 *
 * Refuses before sending anything when the signer does not own ScoreManager
 * and the loan engine, or when the record's vault already runs today's code.
 *
 * @param {object} hre
 * @param {object} record   a deployment record (deployments/*.json); not mutated
 * @param {object} [opts]
 * @param {string} [opts.why]         kept in the record's `redeploys` entry
 * @param {boolean} [opts.allowDirty] allow uncommitted contracts (tests); the record then says so
 * @returns {Promise<{ record: object, txs: object[] }>}
 */
async function redeployVault(hre, record, opts = {}, log = () => {}) {
  const { ethers } = hre;
  const [owner] = await ethers.getSigners();
  const old = record.contracts?.CollateralVault;
  const engineAddress = record.contracts?.PolarisLoanEngine?.address;
  const scoresAddress = record.contracts?.ScoreManager?.address;
  const token = record.contracts?.Stablecoin?.address;
  if (!old || !engineAddress || !scoresAddress || !token) throw new Error("the record has no CollateralVault, PolarisLoanEngine, ScoreManager or Stablecoin");
  const engine = await ethers.getContractAt("PolarisLoanEngine", engineAddress, owner);
  const scores = await ethers.getContractAt("ScoreManager", scoresAddress, owner);
  for (const [name, c] of [["PolarisLoanEngine", engine], ["ScoreManager", scores]]) {
    const o = await c.owner();
    if (getAddress(o) !== owner.address) throw new Error(`${name} is owned by ${o}, not the signer ${owner.address}`);
  }
  if (await runsTodaysVault(hre, old.address)) throw new Error(`CollateralVault ${old.address} already runs today's code: nothing to replace`);
  const source = headSource();
  if (source.dirty && !opts.allowDirty) throw new Error("contracts/ has uncommitted changes: commit them first, so the record can name the commit this bytecode comes from");
  const previous = await ethers.getContractAt("CollateralVault", old.address, owner);
  const multiplier = await previous.creditMultiplierBps();

  const txs = [];
  const note = async (receipt, contract, call) => {
    const sent = await ethers.provider.getTransaction(receipt.hash);
    txs.push({ nonce: sent.nonce, block: receipt.blockNumber, hash: receipt.hash, contract, call });
  };

  log("CollateralVault (today's code: lockWithPermit, withdrawWithSig)");
  const args = [owner.address, token];
  const factory = await ethers.getContractFactory("CollateralVault", owner);
  const d = await tx.deploy(factory, args);
  await note(d.receipt, "create", "deploy");
  log(`  CollateralVault        ${d.address}  (block ${d.receipt.blockNumber}, gas ${d.receipt.gasUsed})`);
  const vault = d.contract;
  if (multiplier !== (await vault.creditMultiplierBps())) {
    await note(await tx.send(vault, "setCreditMultiplierBps", [multiplier]), "CollateralVault", `setCreditMultiplierBps(${multiplier})`);
  }
  await note(await tx.send(vault, "setLoanEngine", [engineAddress]), "CollateralVault", `setLoanEngine(${engineAddress})`);
  await note(await tx.send(vault, "setSeizer", [engineAddress, true]), "CollateralVault", `setSeizer(${engineAddress}, true)`);
  log("  CollateralVault: loan engine = PolarisLoanEngine, which seizes");
  await note(await tx.send(scores, "setCollateralVault", [d.address]), "ScoreManager", `setCollateralVault(${d.address})`);
  await note(await tx.send(engine, "setCollateralVault", [d.address]), "PolarisLoanEngine", `setCollateralVault(${d.address})`);
  log(`  ScoreManager and PolarisLoanEngine: collateral vault = ${d.address}`);

  const next = JSON.parse(JSON.stringify(record));
  next.contracts.CollateralVault = {
    ...old,
    address: d.address,
    blockNumber: d.receipt.blockNumber,
    txHash: d.receipt.hash,
    gasUsed: d.receipt.gasUsed.toString(),
    args: jsonSafe(args),
    sourceCommit: source.commit,
    ...(source.dirty ? { sourceDirty: true } : {}),
  };
  next.eip712 = { ...next.eip712, CollateralVault: { domain: domainJson(await readDomain(vault)), types: TYPES.CollateralVault } };
  next.redeploys = [
    ...(next.redeploys ?? []),
    {
      at: new Date().toISOString(),
      contract: "CollateralVault",
      replaced: { address: old.address, txHash: old.txHash, sourceCommit: old.sourceCommit ?? record.sourceCommit ?? null },
      address: d.address,
      sourceCommit: source.commit,
      why: opts.why ?? null,
      txs,
    },
  ];
  return { record: next, txs };
}

module.exports = { redeployGuardian, runsTodaysGuardian, redeployVault, runsTodaysVault };
