/**
 * Prove the liquidation path on chain.
 *
 *   npx hardhat run scripts/liquidation-e2e.js --network sepolia
 *
 * Production runs a 3-day grace period, which cannot be demonstrated inside a
 * single run. This deploys a second LoanEngine with a short grace, opens a
 * plan, waits for the instalment to lapse, and liquidates it for real --
 * asserting at each step that the keeper's condition flips exactly when it
 * should and never before.
 *
 * The demo engine is otherwise byte-identical to production; only the
 * constructor argument differs.
 */

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const fmt = (v) => (Number(v) / 1e6).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTERVAL = 45; // seconds between instalments
const GRACE = 45; // seconds of grace after an instalment falls due

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = require("../deployments/sepolia.json").contracts;

  const usdc = await hre.ethers.getContractAt("MockUSDC", d.MockUSDC);
  const scores = await hre.ethers.getContractAt("ScoreManager", d.ScoreManager);

  console.log(`Deploying demo engine with gracePeriod=${GRACE}s…`);
  const engine = await (
    await hre.ethers.getContractFactory("PolarisLoanEngine")
  ).deploy(deployer.address, d.MockUSDC, d.ScoreManager, deployer.address, GRACE);
  await engine.waitForDeployment();
  const engineAddr = await engine.getAddress();
  console.log(`  PolarisLoanEngine (demo)  ${engineAddr}\n`);

  const txs = [];
  const track = (label, hash) => {
    txs.push({ label, hash });
    console.log(`${label.padEnd(36)} ${hash}`);
  };

  await (await scores.setWriter(engineAddr, true)).wait();
  await (await engine.setOriginator(deployer.address, true)).wait();
  await (await usdc.approve(engineAddr, USDC(100_000))).wait();
  await (await engine.fund(USDC(5000))).wait();
  console.log("Permissions wired, engine funded\n");

  // Open a plan. Instalment 1 falls due at +45s and becomes liquidatable at +90s.
  const createTx = await engine.createLoan(
    deployer.address,
    "0x000000000000000000000000000000000000dEaD",
    USDC(100),
    4,
    INTERVAL
  );
  await createTx.wait();
  const loanId = await engine.loanCount();
  track(`Plan opened (loan #${loanId})`, createTx.hash);

  const scoreBefore = await scores.scoreOf(deployer.address);
  console.log(`\nScore before: ${scoreBefore}`);

  // Phase 1 -- current. The keeper's condition must be false.
  assert(
    (await engine.checkLiquidatable(loanId)) === false,
    "a current loan must not be liquidatable"
  );
  console.log(`t+0s     checkLiquidatable = false  (instalment not yet due)`);

  // Phase 2 -- due but inside grace. Still false.
  await waitFor(INTERVAL + 8, "instalment due, inside grace");
  assert(
    (await engine.checkLiquidatable(loanId)) === false,
    "a loan inside its grace period must not be liquidatable"
  );
  console.log(`t+${INTERVAL + 8}s    checkLiquidatable = false  (overdue, still in grace)`);

  // Phase 3 -- grace lapsed. Now true.
  await waitFor(GRACE + 12, "grace period lapsing");
  const liquidatable = await engine.checkLiquidatable(loanId);
  assert(liquidatable === true, "the loan must be liquidatable once grace lapses");
  console.log(`t+${INTERVAL + GRACE + 20}s   checkLiquidatable = TRUE   (grace lapsed)\n`);

  // The action half. This is the transaction a KeeperHub check-and-execute
  // would fire once its condition evaluated true.
  const outstandingBefore = await engine.outstandingOf(loanId);
  const liqTx = await engine.liquidate(loanId);
  await liqTx.wait();
  track("Liquidated", liqTx.hash);

  const loan = await engine.getLoan(loanId);
  assert(loan.status === 2n, `loan status should be Liquidated(2), got ${loan.status}`);
  console.log(`\nLoan status: Liquidated, ${fmt(outstandingBefore)} pUSDC written down`);

  const scoreAfter = await scores.scoreOf(deployer.address);
  assert(scoreAfter < scoreBefore, `score must fall on liquidation: ${scoreBefore} -> ${scoreAfter}`);
  console.log(`Score: ${scoreBefore} → ${scoreAfter} (${scoreAfter - scoreBefore})`);

  // A liquidated loan is terminal -- the keeper must not act on it again.
  assert(
    (await engine.checkLiquidatable(loanId)) === false,
    "a liquidated loan must not remain liquidatable"
  );
  console.log(`checkLiquidatable after = false  (terminal, keeper takes no further action)`);

  await expectRevert(() => engine.liquidate(loanId), "double liquidation must revert");
  console.log(`Second liquidate() reverted as expected`);

  const out = {
    network: "sepolia",
    chainId: 11155111,
    demoEngine: engineAddr,
    gracePeriodSeconds: GRACE,
    intervalSeconds: INTERVAL,
    loanId: loanId.toString(),
    scoreBefore: Number(scoreBefore),
    scoreAfter: Number(scoreAfter),
    writtenDownRaw: outstandingBefore.toString(),
    transactions: txs,
  };
  const outPath = join(__dirname, "..", "deployments", "liquidation-sepolia.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`\nAll assertions passed. Wrote ${outPath}`);
  for (const t of txs) {
    console.log(`  https://sepolia.etherscan.io/tx/${t.hash}`);
  }
}

async function waitFor(seconds, why) {
  console.log(`  … waiting ${seconds}s (${why})`);
  await sleep(seconds * 1000);
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function expectRevert(fn, message) {
  try {
    await (await fn()).wait();
  } catch {
    return;
  }
  throw new Error(`ASSERTION FAILED: ${message}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
