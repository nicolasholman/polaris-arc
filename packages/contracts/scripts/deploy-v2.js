/** Deploy CollateralVault + PolarisPayments and wire them to the live engine. */
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = require("../deployments/sepolia.json").contracts;
  console.log(`Deployer ${deployer.address}`);
  console.log(`Balance  ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH\n`);

  const vault = await (await hre.ethers.getContractFactory("CollateralVault"))
    .deploy(deployer.address, d.MockUSDC);
  await vault.waitForDeployment();
  console.log(`CollateralVault    ${await vault.getAddress()}`);

  const payments = await (await hre.ethers.getContractFactory("PolarisPayments"))
    .deploy(deployer.address, d.MockUSDC, deployer.address);
  await payments.waitForDeployment();
  console.log(`PolarisPayments    ${await payments.getAddress()}`);

  // The live ScoreManager predates collateral support and has no
  // setCollateralVault, so it needs redeploying alongside the engine.
  const scoresNew = await (await hre.ethers.getContractFactory("ScoreManager"))
    .deploy(deployer.address);
  await scoresNew.waitForDeployment();
  const scoresAddr = await scoresNew.getAddress();
  console.log(`ScoreManager       ${scoresAddr}  (collateral-aware)`);

  // A new engine: the live one predates the exploit fixes and cannot be upgraded.
  const engine = await (await hre.ethers.getContractFactory("PolarisLoanEngine"))
    .deploy(deployer.address, d.MockUSDC, scoresAddr, deployer.address, 3 * 24 * 60 * 60);
  await engine.waitForDeployment();
  const engineAddr = await engine.getAddress();
  console.log(`PolarisLoanEngine  ${engineAddr}  (patched)\n`);

  const scores = scoresNew;
  const registry = await hre.ethers.getContractAt("MerchantRegistry", d.MerchantRegistry);
  const usdc = await hre.ethers.getContractAt("MockUSDC", d.MockUSDC);

  console.log("Wiring…");
  await (await scores.setWriter(engineAddr, true)).wait();
  await (await scores.setCollateralVault(await vault.getAddress())).wait();
  await (await vault.setLoanEngine(engineAddr)).wait();
  await (await vault.setSeizer(engineAddr, true)).wait();
  await (await engine.setCollateralVault(await vault.getAddress())).wait();
  await (await engine.setMerchantRegistry(await registry.getAddress())).wait();
  await (await engine.setOriginator(deployer.address, true)).wait();
  console.log("  score writer, collateral vault, merchant registry, originator");

  await (await usdc.approve(engineAddr, 200_000n * 10n ** 6n)).wait();
  await (await engine.fund(100_000n * 10n ** 6n)).wait();
  console.log("  funded 100,000 pUSDC\n");

  const out = {
    ...require("../deployments/sepolia.json"),
    v2DeployedAt: new Date().toISOString(),
    contracts: {
      ...d,
      PolarisLoanEngine: engineAddr,
      CollateralVault: await vault.getAddress(),
      PolarisPayments: await payments.getAddress(),
      ScoreManager: scoresAddr,
      PolarisLoanEngineLegacy: d.PolarisLoanEngine,
      ScoreManagerLegacy: d.ScoreManager,
    },
  };
  writeFileSync(join(__dirname, "..", "deployments", "sepolia.json"), `${JSON.stringify(out, null, 2)}\n`);

  console.log("Paste into .env:\n");
  console.log(`POLARIS_LOAN_ENGINE=${engineAddr}`);
  console.log(`POLARIS_COLLATERAL_VAULT=${await vault.getAddress()}`);
  console.log(`POLARIS_PAYMENTS=${await payments.getAddress()}`);
  console.log(`POLARIS_SCORE_MANAGER=${scoresAddr}`);
}
main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exitCode = 1; });
