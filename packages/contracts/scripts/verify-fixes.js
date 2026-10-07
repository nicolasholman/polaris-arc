/**
 * Prove, against the bytecode actually deployed on Sepolia, that the two fixes
 * are live. Reads the NEW addresses out of deployments/sepolia.json.
 *
 *   npx hardhat run scripts/verify-fixes.js --network sepolia
 *
 * Proof 1 (high severity) -- PolarisLoanEngine.createLoan
 *   Approve exactly one loan's worth, open that loan, then try to open a second
 *   for the same borrower. The old contract compared the allowance against the
 *   new loan's totalOwed alone, so the same approval backed both; the fixed
 *   contract compares against activeDebtOf + totalOwed and must revert
 *   InsufficientAllowance.
 *
 * Proof 2 -- ScoreManager.setCollateralVault
 *   Point it at an EOA. The old contract accepted it, which made creditLimitOf()
 *   revert and therefore bricked every origination in the protocol; the fixed
 *   contract must revert VaultNotAContract.
 *
 * The script is re-runnable: it clears any debt the probe borrower still owes
 * before it starts, and repays the probe loan when it finishes.
 */

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

const PRINCIPAL = 100_000_000n; // 100 pUSDC
const INSTALLMENTS = 4;
const INTERVAL = 3600n; // 1 hour, the contract's minimum

/** Mirror of the engine's interest maths, so the approval is exact. */
function totalOwedFor(principal, installments, interval) {
  const term = BigInt(installments) * interval;
  const interest = (principal * 1000n * term) / (10_000n * 31_536_000n);
  return principal + interest;
}

function decodeRevert(err, ifaces) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === "string" && data !== "0x") {
    for (const iface of ifaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return { name: parsed.name, args: parsed.args.map(String) };
      } catch { /* try the next interface */ }
    }
  }
  if (err?.errorName) return { name: err.errorName, args: (err.errorArgs ?? []).map(String) };
  return { name: null, args: [], raw: err?.shortMessage ?? err?.message ?? String(err) };
}

/**
 * Send a transaction that is expected to revert and wait for it to be mined.
 * ethers throws on a status-0 receipt, so the receipt is recovered from the
 * error -- and waiting matters, because leaving it in the mempool makes every
 * later transaction collide on the nonce.
 */
async function mineExpectingRevert(txPromise) {
  const tx = await txPromise;
  try {
    const rc = await tx.wait();
    return { hash: tx.hash, status: rc.status };
  } catch (err) {
    return { hash: tx.hash, status: err?.receipt?.status ?? null, reason: err?.shortMessage };
  }
}

const results = [];
function assert(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` -- ${detail}` : ""}`);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;
  const d = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "sepolia.json"), "utf8")).contracts;

  console.log(`Deployer        ${deployer.address}`);
  console.log(`LoanEngine      ${d.PolarisLoanEngine}   (new)`);
  console.log(`ScoreManager    ${d.ScoreManager}   (new)`);
  console.log(`CollateralVault ${d.CollateralVault}   (reused)`);
  console.log(`MockUSDC        ${d.MockUSDC}   (reused)\n`);

  const engine = await hre.ethers.getContractAt("PolarisLoanEngine", d.PolarisLoanEngine);
  const scores = await hre.ethers.getContractAt("ScoreManager", d.ScoreManager);
  const usdc = await hre.ethers.getContractAt("MockUSDC", d.MockUSDC);
  const ifaces = [engine.interface, scores.interface];

  const borrower = deployer.address;
  const merchant = deployer.address; // the registered, active merchant
  const owed = totalOwedFor(PRINCIPAL, INSTALLMENTS, INTERVAL);

  // -----------------------------------------------------------------
  // Step 0: start from zero debt, so a re-run is not blocked by its own
  // previous probe loan.
  // -----------------------------------------------------------------
  if ((await engine.activeDebtOf(borrower)) > 0n) {
    console.log("Clearing debt left by a previous run…");
    const n = await engine.loanCount();
    for (let i = 1n; i <= n; i++) {
      const l = await engine.getLoan(i);
      if (l.borrower.toLowerCase() !== borrower.toLowerCase() || l.status !== 0n) continue;
      const outstanding = await engine.outstandingOf(i);
      if ((await usdc.allowance(borrower, d.PolarisLoanEngine)) < outstanding) {
        await (await usdc.approve(d.PolarisLoanEngine, outstanding)).wait();
      }
      const t = await engine.repay(i, outstanding);
      await t.wait();
      console.log(`  repay(${i}, ${outstanding})  ${t.hash}`);
    }
    console.log(`  activeDebtOf now ${await engine.activeDebtOf(borrower)}\n`);
  }

  // -----------------------------------------------------------------
  // Proof 1: the allowance is checked against total exposure, not one loan
  // -----------------------------------------------------------------
  console.log("Proof 1: createLoan sizes the allowance against activeDebtOf + totalOwed");
  console.log(`  principal ${PRINCIPAL} / totalOwed ${owed} / installments ${INSTALLMENTS} / interval ${INTERVAL}s`);
  console.log(`  creditLimitOf(borrower) ${await scores.creditLimitOf(borrower)}`);
  console.log(`  activeDebtOf(borrower)  ${await engine.activeDebtOf(borrower)} (before)`);

  // Approve EXACTLY one loan's worth. Nothing is drawn at origination, so this
  // allowance survives loan 1 intact -- which is precisely what the old
  // contract let a borrower reuse for loan 2.
  if ((await usdc.allowance(borrower, d.PolarisLoanEngine)) !== owed) {
    const t = await usdc.approve(d.PolarisLoanEngine, owed);
    await t.wait();
    console.log(`  approve(engine, ${owed})              ${t.hash}`);
  }
  console.log(`  allowance now ${await usdc.allowance(borrower, d.PolarisLoanEngine)}`);

  const tx1 = await engine.createLoan(borrower, merchant, PRINCIPAL, INSTALLMENTS, INTERVAL);
  const rc1 = await tx1.wait();
  const loanId = await engine.loanCount();
  console.log(`  createLoan #1 -> loanId ${loanId}           ${tx1.hash}  (gas ${rc1.gasUsed})`);
  assert("first loan opens with an exact allowance", rc1.status === 1, `loanId ${loanId}`);

  const debtAfter = await engine.activeDebtOf(borrower);
  const allowanceAfter = await usdc.allowance(borrower, d.PolarisLoanEngine);
  console.log(`  activeDebtOf(borrower)  ${debtAfter}`);
  console.log(`  allowance left          ${allowanceAfter}  (untouched -- nothing is drawn at origination)`);

  // Under the old rule the check was `allowance < totalOwed`, i.e.
  // 100004566 < 100004566 -> false -> the second loan was ALLOWED.
  // Under the fix it is `allowance < activeDebt + totalOwed` -> must revert.
  try {
    await engine.createLoan.staticCall(borrower, merchant, PRINCIPAL, INSTALLMENTS, INTERVAL);
    assert("second loan reverts InsufficientAllowance", false, "createLoan did NOT revert -- fix is NOT live");
  } catch (err) {
    const p = decodeRevert(err, ifaces);
    const ok = p.name === "InsufficientAllowance";
    assert(
      "second loan reverts InsufficientAllowance",
      ok,
      ok ? `have=${p.args[0]} need=${p.args[1]}` : `got ${p.name ?? p.raw}`
    );
    if (ok) {
      const have = BigInt(p.args[0]);
      const need = BigInt(p.args[1]);
      assert(
        "revert args prove the sum, not the single loan",
        need === debtAfter + owed && have === allowanceAfter,
        `need ${need} == activeDebt ${debtAfter} + totalOwed ${owed}`
      );
    }
  }

  // Land the revert on chain too, so there is a tx hash a reviewer can open.
  const r2 = await mineExpectingRevert(
    engine.createLoan(borrower, merchant, PRINCIPAL, INSTALLMENTS, INTERVAL, { gasLimit: 400_000 })
  );
  console.log(`  createLoan #2 (expected revert)       ${r2.hash}  status=${r2.status}`);
  assert("on-chain createLoan #2 tx reverted", r2.status === 0, `status ${r2.status}`);
  console.log(`  loanCount still ${await engine.loanCount()} -- no second loan exists\n`);

  // -----------------------------------------------------------------
  // Proof 2: setCollateralVault refuses a codeless address
  // -----------------------------------------------------------------
  console.log("Proof 2: ScoreManager.setCollateralVault rejects a codeless address");
  const eoa = deployer.address;
  console.log(`  candidate ${eoa}  codeLen=${(await provider.getCode(eoa)).length / 2 - 1}`);
  const vaultBefore = await scores.collateralVault();

  try {
    await scores.setCollateralVault.staticCall(eoa);
    assert("setCollateralVault(EOA) reverts VaultNotAContract", false, "it was ACCEPTED -- fix is NOT live");
  } catch (err) {
    const p = decodeRevert(err, ifaces);
    const ok = p.name === "VaultNotAContract";
    assert("setCollateralVault(EOA) reverts VaultNotAContract", ok, ok ? `vault=${p.args[0]}` : `got ${p.name ?? p.raw}`);
  }

  const r3 = await mineExpectingRevert(scores.setCollateralVault(eoa, { gasLimit: 120_000 }));
  console.log(`  setCollateralVault(EOA) (expected revert) ${r3.hash}  status=${r3.status}`);
  assert("on-chain setCollateralVault(EOA) tx reverted", r3.status === 0, `status ${r3.status}`);

  const vaultAfter = await scores.collateralVault();
  assert("vault pointer unchanged by the rejected call", vaultBefore === vaultAfter, `${vaultAfter}`);

  // Set it back to the real vault explicitly.
  const tx4 = await scores.setCollateralVault(d.CollateralVault);
  await tx4.wait();
  console.log(`  setCollateralVault(realVault)         ${tx4.hash}`);
  const finalVault = await scores.collateralVault();
  assert(
    "collateral vault points at the real vault",
    finalVault.toLowerCase() === d.CollateralVault.toLowerCase(),
    finalVault
  );
  console.log(`  creditLimitOf(deployer) = ${await scores.creditLimitOf(deployer.address)} (score base + collateral boost)\n`);

  // -----------------------------------------------------------------
  // Clean up: repay the probe loan so the demo starts from zero debt
  // -----------------------------------------------------------------
  console.log("Cleanup: repaying the probe loan in full");
  try {
    const outstanding = await engine.outstandingOf(loanId);
    const tx5 = await engine.repay(loanId, outstanding);
    await tx5.wait();
    console.log(`  repay(${loanId}, ${outstanding})                 ${tx5.hash}`);
    const loan = await engine.getLoan(loanId);
    console.log(`  loan status ${loan.status} (1 = Repaid), activeDebtOf ${await engine.activeDebtOf(borrower)}`);
  } catch (err) {
    console.log(`  repay failed (non-fatal, the proofs above stand): ${err.shortMessage ?? err.message}`);
  }

  console.log("\nSummary");
  for (const r of results) console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.label}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    process.exitCode = 1;
    console.log(`\n${failed.length} assertion(s) FAILED.`);
  } else {
    console.log(`\nAll ${results.length} assertions passed against the deployed bytecode.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
