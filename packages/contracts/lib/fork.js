/**
 * Rehearsing on a local fork of Monad testnet (anvil or a Hardhat node with
 * forking), with Agora's real AUSD and its faucet as they stand on testnet.
 *
 * Used by scripts/deploy-monad.js (`deploy:fork`), scripts/fork-fund-pool.js
 * (`fund-pool:fork`) and scripts/fork-smoke.js (`fork:smoke`). Everything
 * that sends a transaction or moves the clock first asks `requireForkNode`,
 * so none of it can reach the real testnet: the public RPC answers neither
 * `anvil_nodeInfo` nor `hardhat_metadata`.
 */

"use strict";

const { Contract, formatUnits } = require("ethers");

const tx = require("./tx");

const MONAD_TESTNET_CHAIN_ID = 10143;

/** Agora's AUSD faucet on Monad testnet (docs/research/ausd.md, §5.1). */
const AGORA_FAUCET = {
  address: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
  abi: ["function requestFunds(address to)", "function faucetDripAmount() view returns (uint256)"],
  // One drip for anyone every 60 seconds; at most 100,000 AUSD per address.
  cooldownSeconds: 60,
  capPerAddress: 100_000n * 10n ** 6n,
};

/**
 * What kind of development node `provider` is, or null for anything else (a
 * public RPC). { kind: "anvil" | "hardhat", forkUrl, forkBlock }; forkUrl is
 * null for a node that is not a fork.
 */
async function devNodeInfo(provider) {
  try {
    const info = await provider.send("anvil_nodeInfo", []);
    const fork = info?.forkConfig ?? {};
    return { kind: "anvil", forkUrl: fork.forkUrl ?? null, forkBlock: fork.forkBlockNumber ?? null };
  } catch {
    // not anvil
  }
  try {
    const meta = await provider.send("hardhat_metadata", []);
    const fork = meta?.forkedNetwork;
    return { kind: "hardhat", forkUrl: fork ? `chain ${fork.chainId}` : null, forkBlock: fork?.forkBlockNumber ?? null };
  } catch {
    return null;
  }
}

/**
 * Refuse anything but a local fork of Monad testnet: a development node
 * (anvil or Hardhat) that forks another chain and answers chain id 10143.
 * Returns devNodeInfo's answer.
 */
async function requireForkNode(provider) {
  const info = await devNodeInfo(provider);
  if (!info) {
    throw new Error(
      "This RPC is not a local development node (no anvil_nodeInfo or hardhat_metadata). " +
        "The fork scripts only run against a local fork of Monad testnet, e.g. " +
        "`anvil --port 18555 --fork-url https://testnet-rpc.monad.xyz --chain-id 10143`."
    );
  }
  if (!info.forkUrl) throw new Error(`This ${info.kind} node is not a fork: start it with --fork-url https://testnet-rpc.monad.xyz.`);
  const { chainId } = await provider.getNetwork();
  if (Number(chainId) !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error(`The fork answers chain ${chainId}; start it with --chain-id ${MONAD_TESTNET_CHAIN_ID} so signatures carry testnet's chain id.`);
  }
  return info;
}

/** Move the fork's clock forward and mine a block. */
async function travel(provider, seconds) {
  await provider.send("evm_increaseTime", [Number(seconds)]);
  await provider.send("evm_mine", []);
}

/**
 * Ask Agora's faucet for AUSD until `to` holds at least `target` base units,
 * on a fork only. The faucet allows one drip every 60 seconds for everyone,
 * so a refused drip moves the fork's clock past the cooldown and tries once
 * more. Returns the number of drips.
 */
async function dripUntil({ provider, signer, token, to, target, log = () => {} }) {
  await requireForkNode(provider);
  if (target > AGORA_FAUCET.capPerAddress) {
    throw new Error(`The faucet pays at most ${formatUnits(AGORA_FAUCET.capPerAddress, 6)} AUSD per address.`);
  }
  const faucet = new Contract(AGORA_FAUCET.address, AGORA_FAUCET.abi, signer);
  const drip = await faucet.faucetDripAmount();
  let drips = 0;
  while ((await token.balanceOf(to)) < target) {
    if (BigInt(drips) * drip > AGORA_FAUCET.capPerAddress) throw new Error(`the faucet's drips did not reach ${to}`);
    try {
      await faucet.requestFunds.staticCall(to);
    } catch {
      await travel(provider, AGORA_FAUCET.cooldownSeconds + 1);
    }
    const receipt = await tx.send(faucet, "requestFunds", [to]);
    drips += 1;
    log(`  faucet drip ${drips}: ${formatUnits(drip, 6)} AUSD to ${to} (gas ${receipt.gasUsed})`);
  }
  return drips;
}

module.exports = { MONAD_TESTNET_CHAIN_ID, AGORA_FAUCET, devNodeInfo, requireForkNode, travel, dripUntil };
