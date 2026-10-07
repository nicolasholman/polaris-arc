/**
 * Make sure a deployer key exists, and say whether it can deploy.
 *
 *   pnpm --filter @polarispay/contracts deployer
 *
 * If the repo-root .env has no DEPLOYER_PRIVATE_KEY, one is generated and
 * appended there (the file must be git-ignored). Prints only the address, its
 * Monad testnet balance from the public RPC, and whether that covers a
 * deployment. Sends nothing and requests nothing from any faucet.
 */

"use strict";

const { JsonRpcProvider, Wallet, formatEther, parseEther } = require("ethers");
const { ensureEnvKey, ENV_FILE } = require("./lib/env");

const RPC = process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz";
/** Enough for the full deployment at ~102 gwei with headroom (deploy-monad.js prints the exact estimate). */
const NEEDED = parseEther(process.env.DEPLOYER_MIN_MON || "3");

async function main() {
  const key = ensureEnvKey("DEPLOYER_PRIVATE_KEY", "Polaris contracts deployer (Monad testnet)");
  const { address } = new Wallet(key);
  const provider = new JsonRpcProvider(RPC, 10143, { staticNetwork: true });
  const balance = await provider.getBalance(address);

  console.log(`Key file  ${ENV_FILE}`);
  console.log(`Deployer  ${address}`);
  console.log(`Balance   ${formatEther(balance)} MON on Monad testnet`);
  if (balance >= NEEDED) {
    console.log("Ready: run `pnpm --filter @polarispay/contracts deploy:monad`.");
  } else {
    console.log(
      `Not enough to deploy (about ${formatEther(NEEDED)} MON). Fund ${address} from the Monad testnet ` +
        "faucet (https://testnet.monad.xyz), then run `pnpm --filter @polarispay/contracts deploy:monad`."
    );
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
