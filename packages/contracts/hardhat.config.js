const path = require("node:path");

require("@nomicfoundation/hardhat-toolbox");
// The repo-root .env (git-ignored). Resolved from this file, not from the
// shell's working directory, so `pnpm --filter` and a plain `npx hardhat` in
// this folder read the same file.
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** The local node the end-to-end run uses: `pnpm node:local` (port 8600). */
const LOCAL_NODE_PORT = Number(process.env.POLARIS_LOCAL_NODE_PORT || 8600);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Monad and Sepolia both have the cancun opcodes.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    // A `hardhat node` started by scripts/e2e-local.js (or `pnpm node:local`).
    // Its accounts are the node's own unlocked test accounts.
    monadLocal: {
      url: `http://127.0.0.1:${LOCAL_NODE_PORT}`,
      chainId: 31337,
    },
    // Monad is EVM-equivalent, so the same compiler settings apply. Monad
    // charges gas on the gas limit rather than gas used, so every sender we
    // write estimates first instead of passing a blanket limit (lib/tx.js).
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
    // A local fork of Monad testnet (anvil, README "Rehearse real AUSD on a
    // fork"): real AUSD and Agora's faucet as they stand on testnet. No key
    // from .env: the node's own unlocked test accounts sign, so this network
    // can send nothing to a public RPC. The fork scripts also refuse any node
    // that is not a local fork (lib/fork.js).
    monadFork: {
      url: process.env.MONAD_FORK_RPC_URL || "http://127.0.0.1:18555",
      chainId: 10143,
    },
    monad: {
      url: process.env.MONAD_RPC_URL || "https://rpc.monad.xyz",
      chainId: 143,
      accounts,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
    },
  },
  etherscan: {
    // One Etherscan V2 key covers Sepolia and Monadscan (Monad testnet is on
    // the free tier: https://docs.etherscan.io/supported-chains). A single
    // string, not one per network: hardhat-verify then speaks V2 and sends
    // `chainid` on every call. Given an object it falls back to V1, drops the
    // `chainid` from the URL below when it checks a contract or polls a
    // submission, and V2 answers "Missing chainid parameter".
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "sepolia",
        chainId: 11155111,
        urls: {
          apiURL: "https://api-sepolia.etherscan.io/api",
          browserURL: "https://sepolia.etherscan.io",
        },
      },
      {
        network: "monadTestnet",
        chainId: 10143,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://testnet.monadscan.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
