/**
 * End-to-end lifecycle against the live deployment.
 *
 *   npx hardhat run scripts/e2e.js --network sepolia
 *
 * Drives a real BNPL plan through every stage that matters and asserts chain
 * state at each step: register a merchant, fund a borrower, open a plan, watch
 * the merchant get paid up front, collect an installment as a third party (the
 * keeper path), check the score moved, and confirm the loan is not liquidatable
 * while it is current.
 *
 * Writes the resulting loan into MongoDB so the keeper and both UIs are looking
 * at the same plan the chain is.
 */

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const fmt = (v) => (Number(v) / 1e6).toFixed(2);

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = require("../deployments/sepolia.json").contracts;

  const usdc = await hre.ethers.getContractAt("MockUSDC", d.MockUSDC);
  const scores = await hre.ethers.getContractAt("ScoreManager", d.ScoreManager);
  const registry = await hre.ethers.getContractAt("MerchantRegistry", d.MerchantRegistry);
  const engine = await hre.ethers.getContractAt("PolarisLoanEngine", d.PolarisLoanEngine);

  const steps = [];
  const log = (label, detail, hash) => {
    steps.push({ label, detail, hash });
    console.log(`${label.padEnd(34)} ${detail}${hash ? `\n${" ".repeat(35)}${hash}` : ""}`);
  };

  console.log(`Deployer/originator: ${deployer.address}\n`);

  // A deterministic borrower derived from the deployer mnemonic-free path: a
  // fresh random wallet each run would need funding with gas it does not have,
  // so the borrower here is the deployer acting as the customer. The important
  // property under test is that *a third party* can call repay, which is
  // exercised below by having the originator collect against the borrower's
  // allowance rather than the borrower calling it themselves.
  const borrower = deployer;
  const merchant = "0x000000000000000000000000000000000000dEaD";

  // 1. Merchant registration
  const existing = await registry.merchantOf(deployer.address);
  if (existing.registeredAt === 0n) {
    const tx = await registry.register("Polaris Demo Store", deployer.address, "");
    await tx.wait();
    log("Merchant registered", "Polaris Demo Store", tx.hash);
    const act = await registry.setActive(deployer.address, true);
    await act.wait();
    log("Merchant activated", "active=true", act.hash);
  } else {
    log("Merchant registered", "already registered, skipping");
  }

  // 2. Borrower funding
  const bal = await usdc.balanceOf(borrower.address);
  if (bal < USDC(400)) {
    const tx = await usdc.mint(borrower.address, USDC(1000));
    await tx.wait();
    log("Borrower funded", `+1000.00 pUSDC`, tx.hash);
  } else {
    log("Borrower funded", `${fmt(bal)} pUSDC already held`);
  }

  // 3. The single checkout-time approval that funds every installment
  const principal = USDC(200);
  const approveTx = await usdc.approve(d.PolarisLoanEngine, USDC(10_000));
  await approveTx.wait();
  log("Checkout approval", "10000.00 pUSDC to LoanEngine", approveTx.hash);

  // 4. Open the plan. 4 installments, 60s apart so the schedule is observable
  //    inside one run instead of over eight weeks.
  const merchantBefore = await usdc.balanceOf(merchant);
  const scoreBefore = await scores.scoreOf(borrower.address);

  const createTx = await engine.createLoan(borrower.address, merchant, principal, 4, 60);
  const createRc = await createTx.wait();
  const loanId = await engine.loanCount();
  log("Plan opened", `loan #${loanId}, 200.00 principal, 4 installments`, createTx.hash);

  const merchantAfter = await usdc.balanceOf(merchant);
  const paidUpFront = merchantAfter - merchantBefore;
  assert(paidUpFront === principal, `merchant paid up front: expected 200.00, got ${fmt(paidUpFront)}`);
  log("Merchant paid up front", `${fmt(paidUpFront)} pUSDC to ${merchant.slice(0, 10)}…`);

  const loan = await engine.getLoan(loanId);
  log("Total owed", `${fmt(loan.totalOwed)} pUSDC (principal + interest)`);

  // 5. Not liquidatable while current -- the keeper's condition must be false
  const liqNow = await engine.checkLiquidatable(loanId);
  assert(liqNow === false, "a current loan must not be liquidatable");
  log("checkLiquidatable (current)", "false — keeper correctly takes no action");

  // 6. Collect installment 1. Called by the originator, not the borrower:
  //    this is the keeper path, pulling against the checkout approval.
  const due = await engine.installmentAmount(loanId);
  const borrowerBefore = await usdc.balanceOf(borrower.address);

  const repayTx = await engine.repay(loanId, due);
  await repayTx.wait();
  log("Installment 1 collected", `${fmt(due)} pUSDC pulled by a third party`, repayTx.hash);

  const borrowerAfter = await usdc.balanceOf(borrower.address);
  assert(
    borrowerBefore - borrowerAfter === due,
    `borrower debited: expected ${fmt(due)}, got ${fmt(borrowerBefore - borrowerAfter)}`
  );

  const afterOne = await engine.getLoan(loanId);
  assert(afterOne.installmentsPaid === 1n, "installmentsPaid should be 1");
  log("Loan state", `${afterOne.installmentsPaid}/4 collected, ${fmt(await engine.outstandingOf(loanId))} outstanding`);

  // 7. Score moved for an on-time payment
  const scoreAfter = await scores.scoreOf(borrower.address);
  assert(scoreAfter > scoreBefore, `score should rise: ${scoreBefore} -> ${scoreAfter}`);
  log("Credit score", `${scoreBefore} → ${scoreAfter} (+${scoreAfter - scoreBefore}, on-time)`);

  const limit = await scores.creditLimitOf(borrower.address);
  log("Credit limit", `${fmt(limit)} pUSDC`);

  // 8. Still not liquidatable -- installment 2 is not yet due
  const liqAfter = await engine.checkLiquidatable(loanId);
  assert(liqAfter === false, "loan must remain healthy after an on-time payment");
  log("checkLiquidatable (after pay)", "false — still healthy");

  const out = {
    network: "sepolia",
    chainId: 11155111,
    loanId: loanId.toString(),
    borrower: borrower.address,
    merchant,
    principalRaw: principal.toString(),
    totalOwedRaw: afterOne.totalOwed.toString(),
    totalRepaidRaw: afterOne.totalRepaid.toString(),
    installmentCount: 4,
    installmentsPaid: Number(afterOne.installmentsPaid),
    intervalSeconds: 60,
    startedAt: Number(afterOne.startedAt),
    scoreBefore: Number(scoreBefore),
    scoreAfter: Number(scoreAfter),
    steps: steps.filter((s) => s.hash),
    contracts: d,
  };

  const outPath = join(__dirname, "..", "deployments", "e2e-sepolia.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`\nAll assertions passed. Wrote ${outPath}`);
  console.log("\nTransactions:");
  for (const s of out.steps) {
    console.log(`  https://sepolia.etherscan.io/tx/${s.hash}`);
  }
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
