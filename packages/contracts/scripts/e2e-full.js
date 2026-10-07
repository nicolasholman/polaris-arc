/**
 * Every product surface, end to end, against the live Sepolia deployment.
 *
 *   npx hardhat run scripts/e2e-full.js --network sepolia
 *
 * Asserts at each step rather than printing and hoping. Covers the three
 * payment modes and the credit machinery underneath them:
 *   direct payment · subscription · BNPL · collateral · credit limit increase
 */

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

const U = (n) => BigInt(Math.round(n * 1e6));
const f = (v) => (Number(v) / 1e6).toFixed(2);
const txs = [];

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
function step(label, detail, hash) {
  if (hash) txs.push({ label, hash });
  console.log(`  ${label.padEnd(42)} ${detail}`);
}

async function main() {
  const [me] = await hre.ethers.getSigners();
  const d = require("../deployments/sepolia.json").contracts;

  const usdc = await hre.ethers.getContractAt("MockUSDC", d.MockUSDC);
  const scores = await hre.ethers.getContractAt("ScoreManager", d.ScoreManager);
  const vault = await hre.ethers.getContractAt("CollateralVault", d.CollateralVault);
  const pay = await hre.ethers.getContractAt("PolarisPayments", d.PolarisPayments);
  const engine = await hre.ethers.getContractAt("PolarisLoanEngine", d.PolarisLoanEngine);
  const registry = await hre.ethers.getContractAt("MerchantRegistry", d.MerchantRegistry);

  const merchant = "0x000000000000000000000000000000000000dEaD";
  console.log(`actor ${me.address}\n`);

  // ---- approvals ---------------------------------------------------
  for (const [name, addr] of [
    ["LoanEngine", d.PolarisLoanEngine],
    ["Payments", d.PolarisPayments],
    ["CollateralVault", d.CollateralVault],
  ]) {
    if ((await usdc.allowance(me.address, addr)) < U(50_000)) {
      const t = await usdc.approve(addr, U(1_000_000));
      await t.wait();
      step(`approve ${name}`, "1,000,000 pUSDC", t.hash);
    }
  }

  // ---- 1. DIRECT PAYMENT -------------------------------------------
  console.log("\n1. DIRECT PAYMENT");
  const orderId = `DIRECT-${Date.now()}`;
  const mBefore = await usdc.balanceOf(merchant);
  const t1 = await pay.pay(merchant, U(25), orderId);
  await t1.wait();
  step("pay 25.00 in full", `merchant +${f((await usdc.balanceOf(merchant)) - mBefore)}`, t1.hash);

  const rec = await pay.paymentFor(merchant, orderId);
  assert(rec.paidAt > 0n, "payment must be recorded");
  assert(rec.amount === U(25), "recorded amount must match");

  let dup = false;
  try {
    await (await pay.pay(merchant, U(25), orderId)).wait();
  } catch {
    dup = true;
  }
  assert(dup, "a repeated orderId must be rejected");
  step("replay same orderId", "rejected — no double charge");

  // ---- 2. SUBSCRIPTION ---------------------------------------------
  console.log("\n2. SUBSCRIPTION");
  const t2 = await pay.createPlan(U(3), 3600, `Pro-${Date.now()}`);
  await t2.wait();
  const planId = await pay.planCount();
  step("create plan", `#${planId}, 3.00 / hour`, t2.hash);

  // The plan's merchant is this same address, so a self-charge nets to zero.
  // Measure the treasury-fee leg instead, which still proves money moved.
  const subBefore = await usdc.balanceOf(me.address);
  const t3 = await pay.subscribe(planId);
  await t3.wait();
  const subId = await pay.subscriptionCount();
  const charged = subBefore - (await usdc.balanceOf(me.address));
  step("subscribe", `#${subId}, first period charged ${f(charged)}`, t3.hash);

  const sub = await pay.getSubscription(subId);
  assert(sub.periodsCharged === 1n, "first period must charge at subscribe time");
  assert(sub.status === 0n, "subscription must be active");
  assert((await pay.isChargeDue(subId)) === false, "must not be immediately re-chargeable");
  step("charge due again?", "false — period has not elapsed");

  const t4 = await pay.cancel(subId);
  await t4.wait();
  assert((await pay.getSubscription(subId)).status === 1n, "cancel must take effect");
  step("cancel (subscriber-initiated)", "status = Cancelled", t4.hash);

  // ---- 3. COLLATERAL + CREDIT LIMIT --------------------------------
  console.log("\n3. COLLATERAL AND CREDIT LIMIT");
  const baseLimit = await scores.baseLimitOf(me.address);
  const limitBefore = await scores.creditLimitOf(me.address);
  step("base limit (score only)", `${f(baseLimit)}`);

  // Deltas, not absolutes: this script is re-runnable and collateral from a
  // previous run is still locked.
  const boostBefore = await vault.creditBoostOf(me.address);
  const lockedBefore = await vault.lockedOf(me.address);

  const t5 = await vault.lock(U(300));
  await t5.wait();
  const boostAfter = await vault.creditBoostOf(me.address);
  const limitAfter = await scores.creditLimitOf(me.address);
  step("lock 300.00 collateral", `boost ${f(boostBefore)} → ${f(boostAfter)}`, t5.hash);
  step("credit limit", `${f(limitBefore)} → ${f(limitAfter)}`);

  assert(
    boostAfter - boostBefore === U(450),
    `150% of 300 should add 450, added ${f(boostAfter - boostBefore)}`
  );
  assert(limitAfter - limitBefore === U(450), "limit must rise by exactly the boost");
  assert((await scores.baseLimitOf(me.address)) === baseLimit, "base limit must be unchanged");
  assert(
    (await vault.withdrawable(me.address)) === lockedBefore + U(300),
    "all collateral must be withdrawable while debt-free"
  );

  // ---- 4. BNPL USING THE RAISED LIMIT ------------------------------
  console.log("\n4. BNPL AGAINST THE RAISED LIMIT");
  let m = await registry.merchantOf(me.address);
  if (m.registeredAt === 0n) {
    await (await registry.register("E2E Store", me.address, "")).wait();
    m = await registry.merchantOf(me.address);
  }
  if (!m.active) {
    await (await registry.setActive(me.address, true)).wait();
  }
  // The default cap is 500, which is below the loan this test opens. Raising it
  // deliberately -- the cap blocking a larger order is the registry working.
  if (m.maxOrderValue < U(5000)) {
    await (await registry.setMaxOrderValue(me.address, U(5000))).wait();
  }
  step("merchant active", `cap ${f((await registry.merchantOf(me.address)).maxOrderValue)}`);

  // Prove the cap actually bites before raising past it.
  await (await registry.setMaxOrderValue(me.address, U(10))).wait();
  let capped = false;
  try {
    await engine.createLoan.staticCall(me.address, me.address, U(100), 4, 3600);
  } catch {
    capped = true;
  }
  assert(capped, "the registry cap must block an oversized order");
  step("order above merchant cap", "rejected by MerchantRegistry");
  await (await registry.setMaxOrderValue(me.address, U(5000))).wait();

  const principal = baseLimit + U(100); // deliberately above the score-only limit
  const t6 = await engine.createLoan(me.address, me.address, principal, 4, 3600);
  await t6.wait();
  const loanId = await engine.loanCount();
  step("open BNPL above base limit", `#${loanId}, ${f(principal)} over 4`, t6.hash);

  assert((await vault.withdrawable(me.address)) === 0n, "collateral must lock while debt is open");
  step("collateral withdrawable now", "0 — locked against the loan");

  // ---- 5. COLLECTION + SCORE ---------------------------------------
  console.log("\n5. COLLECTION");
  const scoreBefore = await scores.scoreOf(me.address);
  const due = await engine.installmentAmount(loanId);
  const t7 = await engine.repay(loanId, due);
  await t7.wait();
  const loan = await engine.getLoan(loanId);
  step("collect instalment 1", `${f(due)} · ${loan.installmentsPaid}/4 paid`, t7.hash);
  assert(loan.installmentsPaid === 1n, "one instalment must be complete");

  const scoreAfter = await scores.scoreOf(me.address);
  step("credit score", `${scoreBefore} → ${scoreAfter}`);
  assert(scoreAfter > scoreBefore, "an on-time payment must raise the score");

  // The dust exploit, against the live patched engine.
  const beforeDust = (await engine.getLoan(loanId)).installmentsPaid;
  const t8 = await engine.repay(loanId, 1n);
  await t8.wait();
  const afterDust = (await engine.getLoan(loanId)).installmentsPaid;
  step("dust repayment (1 unit)", `${beforeDust} → ${afterDust} instalments`, t8.hash);
  assert(afterDust === beforeDust, "dust must not complete an instalment on the live engine");

  console.log("\nAll assertions passed.\n");
  const out = { network: "sepolia", chainId: 11155111, ranAt: new Date().toISOString(), loanId: loanId.toString(), subId: subId.toString(), transactions: txs };
  writeFileSync(join(__dirname, "..", "deployments", "e2e-full-sepolia.json"), `${JSON.stringify(out, null, 2)}\n`);
  for (const t of txs) console.log(`  https://sepolia.etherscan.io/tx/${t.hash}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exitCode = 1; });
