/**
 * Deploy the PolarisPay stack to Sepolia.
 *
 *   pnpm --filter @polarispay/contracts deploy:sepolia
 *
 * Writes deployments/sepolia.json and prints the .env lines to paste back.
 */

const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log(`Network:  ${hre.network.name} (chainId ${net.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} ETH\n`);

  if (balance === 0n) {
    throw new Error(
      `Deployer ${deployer.address} has no ETH. Fund it from a Sepolia faucet ` +
        `(https://www.alchemy.com/faucets/sepolia) and re-run.`
    );
  }

  const usdc = await deploy("MockUSDC");
  const scoreManager = await deploy("ScoreManager", [deployer.address]);
  const registry = await deploy("MerchantRegistry", [deployer.address]);
  // Grace period is per-deployment. Production wants days; a demo deployment
  // wants seconds so the liquidation path can be exercised on chain without
  // waiting three days for it.
  const graceSeconds = Number(process.env.POLARIS_GRACE_SECONDS ?? 3 * 24 * 60 * 60);
  const loanEngine = await deploy("PolarisLoanEngine", [
    deployer.address,
    await usdc.getAddress(),
    await scoreManager.getAddress(),
    deployer.address, // treasury
    graceSeconds,
  ]);
  console.log(`  gracePeriod: ${graceSeconds}s`);

  // The LoanEngine is the only contract allowed to move a credit score, and
  // the deployer is the only originator until the API's signer is registered.
  console.log("\nWiring permissions…");
  await (await scoreManager.setWriter(await loanEngine.getAddress(), true)).wait();
  console.log("  ScoreManager: LoanEngine registered as writer");
  await (await loanEngine.setOriginator(deployer.address, true)).wait();
  console.log("  LoanEngine: deployer registered as originator");

  // Seed protocol liquidity so merchants can actually be paid up front.
  const liquidity = 100_000n * 10n ** 6n;
  await (await usdc.approve(await loanEngine.getAddress(), liquidity)).wait();
  await (await loanEngine.fund(liquidity)).wait();
  console.log(`  LoanEngine: funded with ${liquidity / 10n ** 6n} pUSDC\n`);

  const addresses = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      MockUSDC: await usdc.getAddress(),
      ScoreManager: await scoreManager.getAddress(),
      MerchantRegistry: await registry.getAddress(),
      PolarisLoanEngine: await loanEngine.getAddress(),
    },
  };

  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${hre.network.name}.json`);
  writeFileSync(out, `${JSON.stringify(addresses, null, 2)}\n`);

  console.log(`Saved ${out}\n`);
  console.log("Paste into .env:\n");
  console.log(`POLARIS_USDC=${addresses.contracts.MockUSDC}`);
  console.log(`POLARIS_SCORE_MANAGER=${addresses.contracts.ScoreManager}`);
  console.log(`POLARIS_MERCHANT_REGISTRY=${addresses.contracts.MerchantRegistry}`);
  console.log(`POLARIS_LOAN_ENGINE=${addresses.contracts.PolarisLoanEngine}`);
}

async function deploy(name, args = []) {
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  console.log(`${name.padEnd(20)} ${await contract.getAddress()}`);
  return contract;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
