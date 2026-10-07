/**
 * Arc networks and the Circle contracts Polaris uses on them.
 *
 * One table for the deploy script, the record it writes, and every app: the
 * apps read the record (deployments/arc-<network>.json), which copies the
 * `circle` block below, so a mainnet switch is NETWORK=mainnet and nothing
 * else. Addresses are from https://docs.arc.io/arc/references/contract-addresses
 * and were read back on chain for testnet (USDC/EURC name, version, decimals).
 */

"use strict";

const ARC_TESTNET = {
  key: "testnet",
  hardhatNetwork: "arcTestnet",
  chainId: 5042002,
  name: "Arc Testnet",
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  explorerApiUrl: "https://explorer.testnet.arc.io/api",
  circle: {
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    usyc: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
    cctpDomain: 26,
    tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    stableFxEscrow: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8",
    memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
    multicall3From: "0x522fAf9A91c41c443c66765030741e4AaCe147D0",
    irisApiUrl: "https://iris-api-sandbox.circle.com",
  },
};

const ARC_MAINNET = {
  key: "mainnet",
  hardhatNetwork: "arcMainnet",
  chainId: 5042,
  name: "Arc",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  explorerApiUrl: "https://explorer.arc.io/api",
  circle: {
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    usyc: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490",
    cctpDomain: 26,
    tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
    stableFxEscrow: "0xe2E5F173576B513d994073CCbDaCBE027d43DFe6",
    memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
    multicall3From: "0x522fAf9A91c41c443c66765030741e4AaCe147D0",
    irisApiUrl: "https://iris-api.circle.com",
  },
};

/** A local Hardhat node: MockUSDC and MockEURC, no Circle services. */
const ARC_LOCAL = {
  key: "local",
  hardhatNetwork: "arcLocal",
  chainId: 31337,
  name: "Local (Hardhat)",
  rpcUrl: `http://127.0.0.1:${Number(process.env.POLARIS_LOCAL_NODE_PORT || 8600)}`,
  explorerUrl: null,
  explorerApiUrl: null,
  circle: null,
};

const NETWORKS = { testnet: ARC_TESTNET, mainnet: ARC_MAINNET, local: ARC_LOCAL };

/** The network for NETWORK=testnet|mainnet|local (default testnet). */
function networkFor(key = process.env.NETWORK || "testnet") {
  const n = NETWORKS[key];
  if (!n) throw new Error(`Unknown NETWORK "${key}": use testnet, mainnet or local.`);
  return n;
}

/** The network a Hardhat network name or chain id belongs to, or null. */
function networkByChainId(chainId) {
  return Object.values(NETWORKS).find((n) => n.chainId === Number(chainId)) ?? null;
}

module.exports = { ARC_TESTNET, ARC_MAINNET, ARC_LOCAL, NETWORKS, networkFor, networkByChainId };
