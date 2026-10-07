/**
 * Sending transactions with an estimated gas limit and Arc's fee floor.
 *
 * Gas on Arc is paid in USDC (the native balance, 18 decimals). Every script
 * here estimates first and adds a fixed headroom (15% by default) so a
 * transaction never runs out of gas on a state change between estimate and
 * inclusion, and prices `maxFeePerGas` at or above Arc's 20 gwei mempool
 * floor (https://docs.arc.io/arc/references/evm-differences): a transaction
 * priced under it may sit pending.
 */

"use strict";

const HEADROOM_BPS = 1_500n;

/** Arc's mempool floor for maxFeePerGas: 20 gwei (of native, 18-decimal USDC). */
const ARC_MIN_FEE = 20_000_000_000n;
const ARC_CHAIN_IDS = new Set([5042n, 5042002n]);

/** EIP-1559 fee overrides at or above Arc's floor; {} on other chains (the provider's own pricing). */
async function feeOverrides(provider) {
  if (!provider) return {};
  const { chainId } = await provider.getNetwork();
  if (!ARC_CHAIN_IDS.has(BigInt(chainId))) return {};
  const fee = await provider.getFeeData();
  const max = fee.maxFeePerGas && fee.maxFeePerGas > ARC_MIN_FEE ? fee.maxFeePerGas : ARC_MIN_FEE;
  return { maxFeePerGas: max, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n };
}

function withHeadroom(estimate, headroomBps = HEADROOM_BPS) {
  return (BigInt(estimate) * (10_000n + BigInt(headroomBps))) / 10_000n;
}

/**
 * Call `contract.method(...args)` with gasLimit = estimate + headroom.
 * Returns the mined receipt. `overrides` are passed through (never `gasLimit`).
 */
async function send(contract, method, args = [], { headroomBps = HEADROOM_BPS, overrides = {}, log } = {}) {
  const fn = contract.getFunction(method);
  const estimate = await fn.estimateGas(...args, overrides);
  const gasLimit = withHeadroom(estimate, headroomBps);
  const fees = await feeOverrides(contract.runner?.provider);
  const tx = await fn(...args, { ...fees, ...overrides, gasLimit });
  const receipt = await tx.wait();
  if (log) log(`${method}: gas ${receipt.gasUsed} of limit ${gasLimit} (estimate ${estimate})`);
  return receipt;
}

/**
 * Deploy `factory` with gasLimit = estimate + headroom.
 * Returns { contract, address, receipt, gasLimit }.
 */
async function deploy(factory, args = [], { headroomBps = HEADROOM_BPS } = {}) {
  const runner = factory.runner;
  const txRequest = await factory.getDeployTransaction(...args);
  const estimate = await runner.estimateGas(txRequest);
  const gasLimit = withHeadroom(estimate, headroomBps);
  const fees = await feeOverrides(runner?.provider);
  const contract = await factory.deploy(...args, { ...fees, gasLimit });
  const receipt = await contract.deploymentTransaction().wait();
  return { contract, address: await contract.getAddress(), receipt, gasLimit, estimate };
}

module.exports = { HEADROOM_BPS, ARC_MIN_FEE, withHeadroom, feeOverrides, send, deploy };
