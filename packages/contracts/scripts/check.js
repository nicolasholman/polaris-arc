/**
 * Read-only check of a deployment against its record
 * (deployments/arc-<network>.json): code at every address, every role the
 * deploy granted, the caps, the guard, and the pool. Sends nothing.
 * Exits non-zero if any check fails.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { networkFor } = require("../lib/networks");
const { readDomain } = require("../lib/eip712");

async function main() {
  const network = networkFor();
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `arc-${network.key}.json`), "utf8"));
  const { ethers } = hre;
  const at = (name, label = name) => ethers.getContractAt(name, record.contracts[label].address);
  const a = (label) => record.contracts[label].address;
  const checks = [];
  const check = async (what, fn) => {
    try {
      const ok = await fn();
      checks.push([what, ok === true]);
    } catch (e) {
      checks.push([`${what} (${String(e.message).split("\n")[0]})`, false]);
    }
  };

  for (const [label, c] of Object.entries(record.contracts)) {
    await check(`code at ${label}`, async () => (await ethers.provider.getCode(c.address)) !== "0x");
  }
  const scores = await at("ScoreManager");
  const engine = await at("PolarisLoanEngine");
  const payments = await at("PolarisPayments");
  const checkout = await at("PolarisCheckout");
  const vault = await at("CollateralVault");
  const registry = await at("MerchantRegistry");
  const batch = await at("BatchSettlement");
  const guard = await at("CreditGuard");
  const collections = await at("CollectionsReceiver");
  const underwriting = await at("UnderwritingReceiver");
  const usdc = await ethers.getContractAt("MockUSDC", a("USDC"));

  await check("ScoreManager writer = LoanEngine", () => scores.isWriter(a("PolarisLoanEngine")));
  await check("ScoreManager underwriter = UnderwritingReceiver", () => scores.isUnderwriter(a("UnderwritingReceiver")));
  await check("ScoreManager requireUnderwriting", () => scores.requireUnderwriting());
  await check("ScoreManager vault", async () => (await scores.collateralVault()) === a("CollateralVault"));
  await check("LoanEngine originator = PolarisCheckout", () => engine.isOriginator(a("PolarisCheckout")));
  await check("LoanEngine vault", async () => (await engine.collateralVault()) === a("CollateralVault"));
  await check("LoanEngine registry", async () => (await engine.merchantRegistry()) === a("MerchantRegistry"));
  await check("LoanEngine stablecoin = USDC", async () => (await engine.stablecoin()) === a("USDC"));
  await check("Payments checkout = PolarisCheckout", async () => (await payments.checkout()) === a("PolarisCheckout"));
  await check("Checkout credit guard = CreditGuard", async () => (await checkout.creditGuardian()) === a("CreditGuard"));
  await check("Vault loan engine", async () => (await vault.loanEngine()) === a("PolarisLoanEngine"));
  await check("Vault seizer = LoanEngine", () => vault.isSeizer(a("PolarisLoanEngine")));
  await check("Collections keeper", async () => (await collections.keeper()) === record.roles.keeper);
  await check("Underwriting keeper", async () => (await underwriting.keeper()) === record.roles.keeper);
  if (record.roles.relayer) {
    await check("Payments operator = relayer", () => payments.isOperator(record.roles.relayer));
    await check("Registry operator = relayer", () => registry.isOperator(record.roles.relayer));
    await check("BatchSettlement settler = relayer", () => batch.isSettler(record.roles.relayer));
  }
  await check("Demo merchant active", async () => (await registry.merchantOf(record.demo.merchant)).active);
  await check("USDC domain", async () => {
    const d = await readDomain(usdc);
    return d.name === "USDC" && d.version === "2";
  });
  const pool = await engine.poolState();
  const status = await guard.creditStatus();
  for (const [what, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  console.log(`\n  pool: free cash ${ethers.formatUnits(pool.freeCash, 6)} USDC, owed ${ethers.formatUnits(pool.totalOwed, 6)}, originated ${ethers.formatUnits(pool.totalOriginated, 6)}`);
  console.log(`  credit guard: ${status.paused ? `paused (reasons ${status.reasons})` : "open"}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed} of ${checks.length} checks passed.`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
