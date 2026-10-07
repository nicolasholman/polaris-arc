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
  // Chainlink CCIP on Arc testnet (docs.chain.link/ccip/directory/testnet/chain/arc-testnet).
  // USDC is not a CCIP token on Arc: CCTP moves the dollars, CCIP carries the instruction.
  ccip: {
    chainSelector: "3034092155422581607",
    router: "0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8",
    rmn: "0xD610B8f58689de7755947C05342A2DFaC30ebD57",
    tokenAdminRegistry: "0xd3e461C55676B10634a5F81b747c324B85686Dd1",
    link: "0x745827566D1EFb6B91632df0bFD5a9b5392F54E0",
    feeTokens: ["native USDC", "LINK", "WUSDC 0xbf4B839A7939a52acbF8fC52D5Bd5BFE69a064EA"],
    explorer: "https://ccip.chain.link",
    // Where a buyer can pay a Polaris link from (PolarisCCIPSender deploys there; lanes checked with isChainSupported).
    sources: [
      { name: "Base Sepolia", chainId: 84532, selector: "10344971235874465080", router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", cctpDomain: 6, rpcUrl: "https://sepolia.base.org" },
      { name: "Ethereum Sepolia", chainId: 11155111, selector: "16015286601757825753", router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", cctpDomain: 0, rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" },
    ],
  },
  // No Chainlink Data Feeds are listed for Arc testnet: CreditGuard runs without the peg check here.
  feeds: null,
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
  // Chainlink CCIP on Arc mainnet (docs.chain.link/ccip/directory/mainnet/chain/arc-mainnet).
  ccip: {
    chainSelector: "6370580034781731079",
    router: "0xB79791184973589c38e114D43Eb8E4588C283A18",
    rmn: "0x9A82E768C885DEF7C4b47451Fd4Db53d8B21ed07",
    tokenAdminRegistry: "0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29",
    link: "0x76a443768A5e3B8d1AED0105FC250877841Deb40",
    feeTokens: ["native USDC", "LINK"],
    explorer: "https://ccip.chain.link",
    sources: [
      { name: "Base", chainId: 8453, selector: "15971525489660198786", router: "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", cctpDomain: 6, rpcUrl: "https://mainnet.base.org" },
      { name: "Ethereum", chainId: 1, selector: "5009297550715157269", router: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", cctpDomain: 0, rpcUrl: "https://ethereum-rpc.publicnode.com" },
    ],
  },
  // Chainlink Data Feeds on Arc mainnet (reference-data-directory feeds-arc-mainnet.json): 8 decimals, 24 h heartbeat.
  feeds: {
    usdcUsd: "0x84EA90AC252Dc437031461836DB5164219147905",
    eurcUsd: "0x361b95c10b76Ca3f35C686d423e43A951755Bf23",
    eurUsd: "0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D",
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
  ccip: null,
  feeds: null,
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
