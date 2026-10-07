const path = require("node:path");

require("@nomicfoundation/hardhat-toolbox");
// The repo-root .env.local (git-ignored), if any. The deployer key is never
// kept in this repo: scripts/deploy.js reads it from the environment, which the
// deploy command fills by sourcing the key file outside the repo (MAINNET.md).
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local"), quiet: true });

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** The local node: `pnpm node:local` (port 8600). */
const LOCAL_NODE_PORT = Number(process.env.POLARIS_LOCAL_NODE_PORT || 8600);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Arc targets Osaka, a superset of cancun.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // `pnpm demo:local` mines a block every second (POLARIS_INTERVAL_MINING_MS),
      // as Arc does every ~0.5 s, so the chain's clock moves and instalments fall due.
      ...(process.env.POLARIS_INTERVAL_MINING_MS ? { mining: { auto: true, interval: Number(process.env.POLARIS_INTERVAL_MINING_MS) } } : {}),
    },
    // A `hardhat node` for the local stack (`pnpm node:local`, port 8600).
    // Its accounts are the node's own unlocked test accounts.
    arcLocal: {
      url: `http://127.0.0.1:${LOCAL_NODE_PORT}`,
      chainId: 31337,
    },
    // Arc testnet. Gas is USDC; lib/tx.js prices every transaction at or
    // above Arc's 20 gwei floor.
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts,
    },
    // CCIP source chains, where PolarisCCIPSender deploys (scripts/ccip-deploy-sender.js, user-run).
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org", chainId: 84532, accounts },
    ethereumSepolia: { url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", chainId: 11155111, accounts },
    base: { url: process.env.BASE_RPC_URL || "https://mainnet.base.org", chainId: 8453, accounts },
    ethereum: { url: process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com", chainId: 1, accounts },
    // Arc mainnet. scripts/deploy.js refuses it without POLARIS_CONFIRM_MAINNET=yes.
    arcMainnet: {
      url: process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io",
      chainId: 5042,
      accounts,
    },
  },
  // Arc's explorers are Blockscout, which takes any API key.
  etherscan: {
    apiKey: { arcTestnet: "blockscout", arcMainnet: "blockscout" },
    customChains: [
      {
        network: "arcTestnet",
        chainId: 5042002,
        urls: { apiURL: "https://explorer.testnet.arc.io/api", browserURL: "https://explorer.testnet.arc.io" },
      },
      {
        network: "arcMainnet",
        chainId: 5042,
        urls: { apiURL: "https://explorer.arc.io/api", browserURL: "https://explorer.arc.io" },
      },
    ],
  },
  sourcify: { enabled: false },
};
