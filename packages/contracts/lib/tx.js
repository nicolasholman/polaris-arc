/**
 * Sending transactions with an estimated gas limit.
 *
 * Monad charges gas on the gas LIMIT, not on gas used
 * (https://docs.monad.xyz/developer-essentials/gas-pricing), so a blanket
 * limit is paid in full every time. Every script here estimates first and adds
 * a fixed headroom (15% by default, plan section 5.3), and never sends without
 * a limit.
 */

"use strict";

const HEADROOM_BPS = 1_500n;

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
  const tx = await fn(...args, { ...overrides, gasLimit });
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
  const contract = await factory.deploy(...args, { gasLimit });
  const receipt = await contract.deploymentTransaction().wait();
  return { contract, address: await contract.getAddress(), receipt, gasLimit, estimate };
}

module.exports = { HEADROOM_BPS, withHeadroom, send, deploy };
