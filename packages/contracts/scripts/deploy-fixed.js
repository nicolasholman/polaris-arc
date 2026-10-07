/**
 * Redeploy ONLY the two contracts whose source was fixed after the last
 * Sepolia deployment, and rewire the live stack to them.
 *
 *   npx hardhat run scripts/deploy-fixed.js --network sepolia
 *
 * What changed in source and is therefore NOT live yet:
 *   PolarisLoanEngine  createLoan() now sizes the required allowance against
 *                      activeDebtOf[borrower] + totalOwed, not totalOwed alone.
 *                      One approval sized for a single plan could otherwise
 *                      back every plan the credit limit allowed.
 *   ScoreManager       setCollateralVault() now reverts VaultNotAContract on a
 *                      codeless address, because creditLimitOf() cannot catch a
 *                      return-data decode failure and one typo would brick
 *                      origination for every borrower.
 *
 * Everything else is REUSED. MockUSDC in particular holds every demo balance;
 * redeploying it would wipe them. This script never deploys it -- that is the
 * whole reason it exists instead of scripts/deploy.js.
 */

const { writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

const DEPLOYMENTS = join(__dirname, "..", "deployments", "sepolia.json");

/** Live addresses that must survive this deployment untouched. */
const REUSE = {
  MockUSDC: "0x49C86277a91002c4943837bf20F6ED41976Db09F",
  MerchantRegistry: "0xb2eCAD5bE07971deE1be161C39569705186AdFD6",
  CollateralVault: "0xDb6781ed843Ba07Af3321bB8C3952db643324b98",
  PolarisPayments: "0x3BD1609abDC915eA9e01A399a26e2B8A2a06243f",
  BatchSettlement: "0xc319dB6F56B3cdA82d2Bcb2eFA75e5c4993B705f",
};

const txs = [];

async function send(label, promise) {
  const tx = await promise;
  const receipt = await tx.wait();
  txs.push({ label, hash: tx.hash, gasUsed: receipt.gasUsed.toString() });
  console.log(`  ${label.padEnd(42)} ${tx.hash}`);
  return receipt;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;
  const net = await provider.getNetwork();

  console.log(`Network:  ${hre.network.name} (chainId ${net.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${hre.ethers.formatEther(await provider.getBalance(deployer.address))} ETH\n`);

  // Refuse to run against a chain where the reused addresses do not exist --
  // deploying half a stack is worse than deploying none of it.
  for (const [name, addr] of Object.entries(REUSE)) {
    const code = await provider.getCode(addr);
    if (code === "0x") {
      throw new Error(`Reused contract ${name} at ${addr} has no code on ${hre.network.name}. Aborting.`);
    }
  }
  console.log("Reused contracts verified on chain:");
  for (const [name, addr] of Object.entries(REUSE)) console.log(`  ${name.padEnd(18)} ${addr}`);
  console.log();

  // ---------------------------------------------------------------
  // Deploy
  // ---------------------------------------------------------------
  console.log("Deploying fixed contracts…");
  const scoreManager = await deploy("ScoreManager", [deployer.address]);
  const scoreManagerAddr = await scoreManager.getAddress();

  const graceSeconds = Number(process.env.POLARIS_GRACE_SECONDS ?? 3 * 24 * 60 * 60);
  const loanEngine = await deploy("PolarisLoanEngine", [
    deployer.address,
    REUSE.MockUSDC,
    scoreManagerAddr,
    deployer.address, // treasury
    graceSeconds,
  ]);
  const loanEngineAddr = await loanEngine.getAddress();
  console.log(`  gracePeriod: ${graceSeconds}s\n`);

  // ---------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------
  const vault = await hre.ethers.getContractAt("CollateralVault", REUSE.CollateralVault);
  const usdc = await hre.ethers.getContractAt("MockUSDC", REUSE.MockUSDC);

  console.log("Wiring permissions…");
  await send("ScoreManager.setWriter(engine, true)", scoreManager.setWriter(loanEngineAddr, true));
  await send("LoanEngine.setOriginator(deployer, true)", loanEngine.setOriginator(deployer.address, true));
  await send("LoanEngine.setCollateralVault(vault)", loanEngine.setCollateralVault(REUSE.CollateralVault));
  await send("LoanEngine.setMerchantRegistry(registry)", loanEngine.setMerchantRegistry(REUSE.MerchantRegistry));

  // The fix under test: a codeless address is now rejected here. The vault is a
  // real contract, so this must succeed.
  await send("ScoreManager.setCollateralVault(vault)", scoreManager.setCollateralVault(REUSE.CollateralVault));

  // The vault must point at the NEW engine, or withdrawals read debt from a
  // dead engine and liquidation cannot seize anything.
  const vaultOwner = await vault.owner();
  if (vaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`CollateralVault owner is ${vaultOwner}, not the deployer. Cannot rewire the vault.`);
  }
  await send("CollateralVault.setLoanEngine(engine)", vault.setLoanEngine(loanEngineAddr));
  await send("CollateralVault.setSeizer(engine, true)", vault.setSeizer(loanEngineAddr, true));

  // ---------------------------------------------------------------
  // Liquidity
  // ---------------------------------------------------------------
  const want = 100_000n * 10n ** 6n;
  const held = await usdc.balanceOf(deployer.address);
  const liquidity = held < want ? held : want;
  if (liquidity === 0n) {
    throw new Error(`Deployer holds no pUSDC; cannot seed liquidity. Engine deployed at ${loanEngineAddr} but unfunded.`);
  }
  if (liquidity < want) {
    console.log(`\nDeployer holds only ${liquidity / 10n ** 6n} pUSDC; funding that instead of 100000.`);
  }
  console.log("\nSeeding liquidity…");
  await send(`MockUSDC.approve(engine, ${liquidity / 10n ** 6n})`, usdc.approve(loanEngineAddr, liquidity));
  await send(`LoanEngine.fund(${liquidity / 10n ** 6n})`, loanEngine.fund(liquidity));

  // ---------------------------------------------------------------
  // Persist, preserving every reused address
  // ---------------------------------------------------------------
  const existing = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const merged = {
    ...existing,
    network: hre.network.name,
    chainId: Number(net.chainId),
    deployer: deployer.address,
    contracts: {
      ...existing.contracts,
      ...REUSE,
      ScoreManager: scoreManagerAddr,
      PolarisLoanEngine: loanEngineAddr,
    },
    fixedDeployedAt: new Date().toISOString(),
    superseded: {
      ...(existing.superseded ?? {}),
      ScoreManager: existing.contracts.ScoreManager,
      PolarisLoanEngine: existing.contracts.PolarisLoanEngine,
    },
  };
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`\nSaved ${DEPLOYMENTS}`);

  console.log("\nNew addresses:");
  console.log(`POLARIS_SCORE_MANAGER=${scoreManagerAddr}`);
  console.log(`POLARIS_LOAN_ENGINE=${loanEngineAddr}`);

  console.log("\nTransactions:");
  for (const t of txs) console.log(`  ${t.hash}  ${t.gasUsed.padStart(8)}  ${t.label}`);
}

async function deploy(name, args = []) {
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  const addr = await contract.getAddress();
  txs.push({ label: `deploy ${name}`, hash: receipt.hash, gasUsed: receipt.gasUsed.toString() });
  console.log(`  ${name.padEnd(20)} ${addr}   ${receipt.hash}`);
  return contract;
}

main().catch((err) => {
  console.error(err.shortMessage ?? err.message ?? err);
  console.error("\nTransactions completed before the failure:");
  for (const t of txs) console.error(`  ${t.hash}  ${t.label}`);
  process.exitCode = 1;
});
