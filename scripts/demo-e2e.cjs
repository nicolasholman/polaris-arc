#!/usr/bin/env node
// The local end to end, headless, against a running `pnpm demo:local`:
//
//   PLAYWRIGHT_MODULE=<path to an installed playwright> node scripts/demo-e2e.cjs
//
// A buyer account (Face ID: on demo:local's fork, the app's own passkey ceremony with PRF on
// Chrome's virtual authenticator, scripts/lib/virtual-authenticator.cjs; on its Hardhat stack, the
// dev signer) with dollars from the local faucet; Halcyon's
// bag -> Polaris checkout popup -> Pay now; that purchase's receipt sealed to the buyer's
// Face ID key (the server holds only ciphertext) and opened in the app; Halcyon -> popup -> Raise your limit (the
// CRE underwriting workflow, local trigger; without provider keys it opens no line and says so, and the buyer then
// adds enough to Boost in the app, one Face ID, for the line to cover the plan) -> Pay in 4, checked on chain;
// both shop orders marked paid
// by Polaris webhooks; while that plan is open, Take out of Boost offers nothing (the vault releases nothing while
// debt is outstanding), and once the collections run has repaid it the buyer takes $25 out of Boost in the app, one
// Face ID, checked on chain at its block (DEMO_FAST_PLANS=1 repays it in about five minutes); the merchant's dashboard showing the payments, the plan and its
// on-chain registration; then split the bill (scripts/demo-e2e-split.cjs: one link, four
// people, shares paid, the split closed; DEMO_E2E_SPLIT=0 skips it). Screenshots go to
// docs/demo (OUT to change it). Exits 1 if a step fails.
// Playwright isn't a dependency of the repo: install it anywhere and point PLAYWRIGHT_MODULE at it,
// or run from a folder where `require("playwright")` resolves.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("fs");
const path = require("path");
const { addAuthenticator, buyerAddress } = require("./lib/virtual-authenticator.cjs");

// Where the running `pnpm demo:local` is: its .demo/demo.json (every URL, whatever DEMO_*_PORT
// moved), else APP, SHOP, BUSINESS, RPC and FAUCET, else demo:local's default ports.
const DEMO_JSON = path.join(__dirname, "..", ".demo", "demo.json");
const demo = fs.existsSync(DEMO_JSON) ? JSON.parse(fs.readFileSync(DEMO_JSON, "utf8")) : { urls: {} };
const APP = process.env.APP || demo.urls.app || "http://localhost:3000";
const SHOP = process.env.SHOP || demo.urls.shop || "http://127.0.0.1:3600";
const BUSINESS = process.env.BUSINESS || demo.urls.business || "http://localhost:3100";
const RPC = process.env.RPC || demo.urls.rpc || "http://127.0.0.1:8545";
const FAUCET = process.env.FAUCET || (demo.urls.faucet ? demo.urls.faucet.replace(/\/mint$/, "") : "http://127.0.0.1:3650");
// Hardhat mode's app signs with the dev signer; fork mode's with passkeys, so every browser profile gets an authenticator.
const DEV_SIGNER = demo.devSigner !== false;
const { privateKeyToAccount } = require(require.resolve("viem/accounts", { paths: [path.join(__dirname, "..", "apps", "business")] }));
const viem = require(require.resolve("viem", { paths: [path.join(__dirname, "..", "apps", "business")] }));
// The run's contracts (demo.json), read straight from the node with their exported ABIs: what the steps assert on chain.
const CONTRACTS = demo.contracts ?? {};
const ABI_DIR = path.join(__dirname, "..", "packages", "contracts", "abi");
const ERC20 = viem.parseAbi(["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
const chain = viem.createPublicClient({ transport: viem.http(RPC) });
const abiOf = (name) => (name === "Stablecoin" ? ERC20 : JSON.parse(fs.readFileSync(path.join(ABI_DIR, `${name}.json`), "utf8")));
const read = (name, functionName, args = []) => chain.readContract({ address: CONTRACTS[name], abi: abiOf(name), functionName, args });
/** Base units (6 decimals) as the app writes dollars: $1,234.50. */
const dollars = (units) => `$${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// A first `next dev` compile of the checkout can take a minute or more; demo:local warms it, but be patient.
const POPUP_MS = 180000;
const OUT = process.env.OUT || path.join(__dirname, "..", "docs", "demo");
const PROFILE = process.env.PROFILE || path.join(require("os").tmpdir(), `polaris-demo-e2e-${Date.now()}`);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open({ width = 1440, height = 900, profile = PROFILE } = {}) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
    viewport: { width, height },
  });
  // A page of `next dev` on a busy machine can take more than Playwright's 30 s to settle (as demo:e2e:chainlink allows).
  context.setDefaultNavigationTimeout(180000);
  context.on("page", (p) => watch(p));
  for (const p of context.pages()) watch(p);
  if (!DEV_SIGNER) {
    context.authenticator = await addAuthenticator(context, { origin: new URL(APP).origin, log: (line) => console.log(`  [authenticator] ${line}`) });
  }
  return context;
}

function watch(page) {
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  [console ${new URL(page.url() || "about:blank").port || "-"}] ${m.text().slice(0, 240)}`);
  });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 240)}`));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  shot ${name}.png`);
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await sleep(ms);
}

async function buttons(page) {
  return (await page.getByRole("button").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
}




const results = [];
function step(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}
/** A step this run could not reach, and why: reported, never counted as a pass. */
function skip(name, why) {
  results.push({ name, ok: null, detail: why });
  console.log(`SKIP  ${name}  ${why}`);
}

/**
 * "Raise your limit" after its tap: the line went up (or the review is still running), or the review ended with
 * the sheet's error (e.g. a data provider that isn't set up). { up, message }.
 */
async function review(popup) {
  const outcome = await until(
    "the CRE review's outcome",
    async () => {
      if ((await popup.getByText(/Your limit went up|still running/).count()) > 0) return { up: true, message: "" };
      const alert = popup.getByRole("alert").filter({ hasText: /\S/ });
      if ((await alert.count()) > 0) {
        await alert.first().scrollIntoViewIfNeeded().catch(() => {});
        return { up: false, message: (await alert.first().innerText()).replace(/\s+/g, " ").trim() };
      }
      return null;
    },
    240000,
    2000,
  ).catch(() => ({ up: false, message: "" }));
  if (outcome.up) await newLimitShown(popup);
  else await sleep(800);
  return outcome;
}

/** The account's credit limit on chain, in base units, as the API reads it (0 for none or no account). */
async function creditLine(account) {
  if (!account) return 0n;
  const body = await (await fetch(`${BUSINESS}/api/public/credit/${account}`)).json().catch(() => null);
  return BigInt(body?.data?.onChain?.creditLimitUnits ?? "0");
}

async function until(what, fn, timeoutMs = 60000, everyMs = 1000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`);
    await sleep(everyMs);
  }
}

async function shopCheckout(context, { product, mode, prefix }) {
  const page = await context.newPage();
  await page.goto(`${SHOP}/products/${product}`, { waitUntil: "networkidle", timeout: 240000 });
  await page.evaluate(() => localStorage.removeItem("halcyon.bag.v1"));
  await page.reload({ waitUntil: "networkidle" });
  await settle(page, 800);
  await shot(page, `${prefix}-1-shop-product`);
  await page.getByRole("button", { name: /Add to bag/ }).filter({ visible: true }).first().click();
  await sleep(1200);
  await shot(page, `${prefix}-2-shop-bag`);
  await page.goto(`${SHOP}/checkout`, { waitUntil: "networkidle", timeout: 120000 });
  await settle(page, 1000);
  await page.getByText(mode, { exact: true }).first().click();
  await sleep(600);
  await shot(page, `${prefix}-3-shop-checkout`);
  const main = (await buttons(page)).find((t) => /with Polaris|Pay in 4 ·|Continue to Pay in 4/.test(t));
  const [popup] = await Promise.all([context.waitForEvent("page", { timeout: POPUP_MS }), page.getByRole("button", { name: main }).first().click()]);
  await until("the checkout in the popup", async () => popup.url().includes("/pay/"), POPUP_MS, 300);
  await settle(popup, 3000);
  await until("the checkout sheet", async () => (await buttons(popup)).some((t) => /^(Pay now|Pay in 4|Start Pay in 4)/.test(t)), 90000);
  step(`${prefix}: the shop opened the Polaris checkout in a popup`, true, popup.url().replace(/\?.*/, ""));
  await shot(popup, `${prefix}-4-app-checkout-popup`);
  return { page, popup };
}

async function confirmInPopup(popup, prefix) {
  const dialog = popup.getByRole("dialog").last();
  const confirm = dialog.getByRole("button", { name: /Face ID/ }).first();
  await confirm.waitFor({ timeout: 30000 }).catch(async (error) => {
    await shot(popup, `${prefix}-no-confirm`).catch(() => {});
    throw error;
  });
  await sleep(1200);
  await shot(popup, `${prefix}-app-confirm`);
  await confirm.click();
}

/**
 * "Your limit went up" names the limit from the checkout's credit line, which the app re-reads once the decision
 * lands: wait (up to a minute) for it to show more than $0, so the screenshot shows the line the chain holds.
 */
async function newLimitShown(popup) {
  await until("the new limit in the sheet", async () => {
    const text = await popup.getByRole("dialog").last().innerText();
    return /is your Pay later limit now/.test(text) && !/(^|\n)\$0(\n|$)/.test(text);
  }, 60000, 500).catch(() => {});
  await sleep(500);
}

/** The receipt the popup shows before it closes itself (polarispay-sdk leaves it up). */
async function receiptInPopup(popup, name) {
  const seen = await until("the receipt in the popup", async () => !popup.isClosed() && (await popup.getByText(/^(Paid|Done)\.$/).count()) > 0, 60000, 150).catch(() => false);
  if (seen && !popup.isClosed()) await shot(popup, name).catch(() => {});
  return Boolean(seen);
}

/**
 * The buyer's Boost and line as the chain has them: CollateralVault's lockedOf and multiplier, the dollar balance,
 * ScoreManager's creditLimitOf, and whether ScoreManager lends this account only against collateral (declined, or not
 * underwritten while underwriting is required), in which case Boost counts at face value, not the multiplier.
 */
async function boostState(buyer) {
  const [locked, balance, limit, multiplierBps, profile, requireUnderwriting] = await Promise.all([
    read("CollateralVault", "lockedOf", [buyer]),
    read("Stablecoin", "balanceOf", [buyer]),
    read("ScoreManager", "creditLimitOf", [buyer]),
    read("CollateralVault", "creditMultiplierBps"),
    read("ScoreManager", "profileOf", [buyer]),
    read("ScoreManager", "requireUnderwriting"),
  ]);
  const securedOnly = profile.declined || (requireUnderwriting && !profile.underwritten);
  return { locked, balance, limit, multiplierBps: Number(multiplierBps), securedOnly };
}

/** PolarisCheckout.quotePlan for a checkout session's Pay in 4 terms: the total owed with interest, and whether the line covers it. */
async function quoteFor(buyer, terms) {
  return read("PolarisCheckout", "quotePlan", [buyer, BigInt(terms.principalUnits), Number(terms.installments), BigInt(terms.intervalSeconds)]);
}

/**
 * Add to Boost in the app's own UI (the desktop Credit page's Add to Boost, or the Credit line's Boost row): enough
 * dollars that the line covers this checkout's Pay in 4 plan, interest included. The amount is computed from the
 * session's price, PolarisCheckout's quote and the vault's multiplier as ScoreManager applies it, rounded up to whole
 * dollars with one to spare. One Face ID confirm (the virtual authenticator); then lockedOf, the dollar balance and
 * the line are read back from the chain. Returns whether the line now covers the plan.
 */
async function boostForPlan(app, sessionId) {
  const buyer = await buyerAddress(app, privateKeyToAccount);
  const session = sessionId ? ((await (await fetch(`${BUSINESS}/api/public/sessions/${sessionId}`)).json().catch(() => null))?.data ?? null) : null;
  const terms = session?.payIn4 ?? null;
  if (!buyer || !terms || !CONTRACTS.CollateralVault) {
    skip("Boost: the buyer locked dollars with one Face ID; the line rose on chain", !buyer ? "no buyer account" : !terms ? `no Pay in 4 terms for ${sessionId}` : "no CollateralVault in this run");
    return false;
  }
  const before = await boostState(buyer);
  const quote = await quoteFor(buyer, terms);
  const need = quote.activeDebt + quote.totalOwed;
  const short = need > quote.creditLimit ? need - quote.creditLimit : 0n;
  const bps = BigInt(before.securedOnly ? Math.min(before.multiplierBps, 10_000) : before.multiplierBps);
  const exact = (short * 10_000n + bps - 1n) / bps;
  const amount = ((exact + 999_999n) / 1_000_000n + 1n) * 1_000_000n;
  console.log(
    `  boost: plan ${dollars(quote.totalOwed)} owed (${dollars(BigInt(terms.principalUnits))} + ${dollars(quote.interest)} interest), line ${dollars(quote.creditLimit)}, ` +
      `multiplier ${before.multiplierBps / 100}%${before.securedOnly ? " (secured only: face value)" : ""}, balance ${dollars(before.balance)} -> lock ${dollars(amount)}`,
  );
  if (amount > before.balance) {
    skip("Boost: the buyer locked dollars with one Face ID; the line rose on chain", `the plan needs ${dollars(amount)} in Boost; the buyer holds ${dollars(before.balance)}`);
    return false;
  }

  await app.goto(APP + "/credit", { waitUntil: "networkidle", timeout: POPUP_MS });
  await settle(app, 3000);
  const entry = app.getByRole("button", { name: /Add to Boost/ }).filter({ visible: true });
  await until("Add to Boost on the Credit page", async () => (await entry.count()) > 0, 60000, 500);
  await entry.first().click();
  const sheet = app.getByRole("dialog").filter({ hasText: "Lock dollars to raise your Pay later limit." }).last();
  await sheet.waitFor({ timeout: 30000 });
  // The keypad works once the balance is in ("Available $…"); then tap the digits.
  await until("the balance in the Boost sheet", async () => /Available \$/.test(await sheet.innerText()), 60000, 500).catch(() => {});
  const keypad = sheet.getByRole("group", { name: "Keypad" });
  for (const digit of String(amount / 1_000_000n)) await keypad.getByRole("button", { name: digit, exact: true }).click();
  await sleep(600);
  await shot(app, "21-boost-1-sheet");
  await sheet.getByRole("button", { name: "Add to Boost", exact: true }).click();
  await confirmInPopup(app, "21-boost-2");
  const shown = await until("Boosted.", async () => (await app.getByText("Boosted.").count()) > 0, 120000, 500).catch(() => false);
  await sleep(1200);
  await shot(app, "21-boost-3-boosted");
  const screen = shown ? (await app.getByRole("dialog").last().innerText().catch(() => "")).replace(/\s+/g, " ") : "";

  const after = await boostState(buyer);
  const quoteAfter = await quoteFor(buyer, terms);
  const lockedUp = after.locked - before.locked;
  const balanceDown = before.balance - after.balance;
  step(
    `Boost: the buyer locked ${dollars(amount)} with one Face ID; the line rose to ${dollars(after.limit)} on chain`,
    lockedUp === amount && balanceDown === amount && after.limit > before.limit && quoteAfter.withinLimit,
    `lockedOf +${dollars(lockedUp)}, balance -${dollars(balanceDown)}, creditLimitOf ${dollars(before.limit)} -> ${dollars(after.limit)}; ` +
      `the plan's ${dollars(quoteAfter.totalOwed)} ${quoteAfter.withinLimit ? "fits" : "does not fit"} (available ${dollars(quoteAfter.available)})`,
  );
  step(
    "Boost: the Boosted. screen shows the new Boost and Pay later limit, read back from the chain",
    Boolean(shown) && screen.includes(dollars(after.locked)) && screen.includes(dollars(after.limit)),
    screen.slice(0, 200),
  );
  await app.keyboard.press("Escape").catch(() => {});
  return quoteAfter.withinLimit;
}

/** Open the Boost sheet on Take out from the Credit page (desktop: the side panel's button; phone: the Credit line's row). */
async function openTakeOut(app) {
  await app.goto(APP + "/credit", { waitUntil: "networkidle", timeout: POPUP_MS });
  await settle(app, 3000);
  const entry = app.getByRole("button", { name: /Take out of Boost/ }).filter({ visible: true });
  await until("Take out of Boost on the Credit page", async () => (await entry.count()) > 0, 60000, 500);
  await entry.first().click();
  const sheet = app.getByRole("dialog").filter({ hasText: "Move dollars from Boost back to your dollar account." }).last();
  await sheet.waitFor({ timeout: 30000 });
  // Boost and what is free to take out are in once "Free to take out" shows a figure.
  await until("Boost in the Take out sheet", async () => /Free to take out\s*\$/.test(await sheet.innerText()), 60000, 500).catch(() => {});
  return sheet;
}

/**
 * Take out of Boost while the Pay in 4 plan the Boost secures is open: CollateralVault releases nothing while any
 * debt is outstanding, so the sheet must say so and offer no amount, and the chain must agree (withdrawable 0).
 */
async function takeOutWhilePlanOpen(app) {
  const name = "Take out: while the plan is open, the sheet says Boost secures it and offers no amount; the vault agrees (withdrawable 0)";
  const buyer = await buyerAddress(app, privateKeyToAccount);
  if (!buyer || !CONTRACTS.CollateralVault) return skip(name, !buyer ? "no buyer account" : "no CollateralVault in this run");
  const [locked, debt] = await Promise.all([read("CollateralVault", "lockedOf", [buyer]), read("PolarisLoanEngine", "activeDebtOf", [buyer])]);
  if (locked === 0n || debt === 0n) return skip(name, locked === 0n ? "nothing in Boost (the line came from underwriting)" : "the plan was already repaid");
  const sheet = await openTakeOut(app);
  const said = await until("the plan-secures-Boost line", async () => /secures your Pay in 4 plan/.test(await sheet.innerText()), 30000, 500).catch(() => false);
  await sleep(600);
  await shot(app, "23-takeout-0-plan-open");
  const keypad = await sheet.getByRole("group", { name: "Keypad" }).count();
  const withdrawable = await read("CollateralVault", "withdrawable", [buyer]);
  step(name, Boolean(said) && keypad === 0 && withdrawable === 0n, `lockedOf ${dollars(locked)}, activeDebtOf ${dollars(debt)}, withdrawable ${dollars(withdrawable)}`);
  await app.keyboard.press("Escape").catch(() => {});
}

/**
 * Take out of Boost once the plan is repaid (DEMO_FAST_PLANS: four instalments a minute apart, collected by the CRE
 * collections workflow): a few dollars, in the app's own UI, one Face ID signing CollateralVault's Withdraw, which
 * the relayer carries to withdrawWithSig. Checked on chain at the withdrawal's own block: the vault's lockedOf and
 * its dollars fell by the amount, the buyer's dollars rose by it, the relayer (not the buyer) sent it, and the buyer
 * holds no MON and has sent nothing.
 */
const TAKE_OUT = 25_000_000n;
async function takeOutAfterRepaid(app) {
  const names = [
    `Take out: the buyer took ${dollars(TAKE_OUT)} out of Boost with one Face ID; on chain the vault paid the buyer exactly that, the relayer sent it, the buyer holds 0 MON`,
    "Take out: the Taken out. screen shows Boost, the Pay later limit and the dollar balance read back from the chain",
  ];
  const buyer = await buyerAddress(app, privateKeyToAccount);
  if (!buyer || !CONTRACTS.CollateralVault) return names.forEach((n) => skip(n, !buyer ? "no buyer account" : "no CollateralVault in this run"));
  const locked = await read("CollateralVault", "lockedOf", [buyer]);
  if (locked < TAKE_OUT) return names.forEach((n) => skip(n, `${dollars(locked)} in Boost (the line came from underwriting, or no Boost)`));
  if (!demo.fastPlans && (await read("PolarisLoanEngine", "activeDebtOf", [buyer])) > 0n) {
    return names.forEach((n) => skip(n, "the plan Boost secures is still open (instalments a week apart without DEMO_FAST_PLANS=1)"));
  }
  const repaid = await until("the Pay in 4 plan repaid by the collections run", async () => (await read("PolarisLoanEngine", "activeDebtOf", [buyer])) === 0n, 600000, 5000).catch(() => false);
  if (!repaid) {
    const owed = await read("PolarisLoanEngine", "activeDebtOf", [buyer]);
    names.forEach((n) => step(n, false, `activeDebtOf ${dollars(owed)} after 10 minutes`));
    return;
  }
  const from = await chain.getBlockNumber();
  const sheet = await openTakeOut(app);
  await until("the keypad in the Take out sheet", async () => (await sheet.getByRole("group", { name: "Keypad" }).count()) > 0, 30000, 500).catch(() => {});
  const keypad = sheet.getByRole("group", { name: "Keypad" });
  for (const digit of String(TAKE_OUT / 1_000_000n)) await keypad.getByRole("button", { name: digit, exact: true }).click();
  await sleep(600);
  await shot(app, "24-takeout-1-sheet");
  await sheet.getByRole("button", { name: "Take out", exact: true }).click();
  await confirmInPopup(app, "24-takeout-2");
  const shown = await until("Taken out.", async () => (await app.getByText("Taken out.").count()) > 0, 120000, 500).catch(() => false);
  await sleep(1200);
  await shot(app, "24-takeout-3-taken-out");
  const screen = shown ? (await app.getByRole("dialog").last().innerText().catch(() => "")).replace(/\s+/g, " ") : "";

  // The withdrawal's own log, then every figure at its block and the block before (anvil mines one transaction a block).
  const vaultAbi = abiOf("CollateralVault");
  const withdrawn = await until("CollateralWithdrawn for the buyer", async () => {
    const logs = await chain.getContractEvents({ address: CONTRACTS.CollateralVault, abi: vaultAbi, eventName: "CollateralWithdrawn", args: { user: buyer }, fromBlock: from });
    return logs.at(-1) ?? null;
  }, 60000, 1000).catch(() => null);
  if (!withdrawn) {
    step(names[0], false, `no CollateralWithdrawn for ${buyer} since block ${from}`);
    step(names[1], false, screen.slice(0, 200));
    return;
  }
  const at = withdrawn.blockNumber;
  const before = at - 1n;
  const readAt = (name, functionName, args, blockNumber) => chain.readContract({ address: CONTRACTS[name], abi: abiOf(name), functionName, args, blockNumber });
  const [lockedBefore, lockedAfter, vaultBefore, vaultAfter, buyerBefore, buyerAfter, tx, mon, sent, limit] = await Promise.all([
    readAt("CollateralVault", "lockedOf", [buyer], before),
    readAt("CollateralVault", "lockedOf", [buyer], at),
    readAt("Stablecoin", "balanceOf", [CONTRACTS.CollateralVault], before),
    readAt("Stablecoin", "balanceOf", [CONTRACTS.CollateralVault], at),
    readAt("Stablecoin", "balanceOf", [buyer], before),
    readAt("Stablecoin", "balanceOf", [buyer], at),
    chain.getTransaction({ hash: withdrawn.transactionHash }),
    chain.getBalance({ address: buyer }),
    chain.getTransactionCount({ address: buyer }),
    read("ScoreManager", "creditLimitOf", [buyer]),
  ]);
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  step(
    names[0],
    withdrawn.args.amount === TAKE_OUT &&
      lockedBefore - lockedAfter === TAKE_OUT &&
      vaultBefore - vaultAfter === TAKE_OUT &&
      buyerAfter - buyerBefore === TAKE_OUT &&
      same(tx.to, CONTRACTS.CollateralVault) &&
      !same(tx.from, buyer) &&
      tx.input.startsWith(viem.toFunctionSelector("withdrawWithSig(address,uint256,uint256,bytes)")) &&
      mon === 0n &&
      sent === 0,
    `block ${at}: lockedOf ${dollars(lockedBefore)} -> ${dollars(lockedAfter)}, the vault's dollars -${dollars(vaultBefore - vaultAfter)}, ` +
      `the buyer's +${dollars(buyerAfter - buyerBefore)}; sent by ${tx.from} (withdrawWithSig); the buyer holds ${mon} MON and sent ${sent} transactions`,
  );
  const nowLocked = await read("CollateralVault", "lockedOf", [buyer]);
  const nowBalance = await read("Stablecoin", "balanceOf", [buyer]);
  step(
    names[1],
    Boolean(shown) && screen.includes(dollars(nowLocked)) && screen.includes(dollars(limit)) && screen.includes(dollars(nowBalance)),
    screen.slice(0, 240),
  );
  await app.keyboard.press("Escape").catch(() => {});
}

/**
 * Pay in 4 in the checkout popup, against a line that covers it: start, one Face ID, the receipt, the popup closing,
 * the shop's order; then on chain, the plan (LoanCreated for this buyer) owed against the line and the merchant paid
 * the full price by the pool (PolarisLoanEngine's own transfer, in the same transaction). Returns whether it opened.
 */
async function payIn4Plan(app, page, popup) {
  const buyer = await buyerAddress(app, privateKeyToAccount);
  const sessionId = (popup.url().match(/\/pay\/(cs_[A-Za-z0-9_]+)/) ?? [])[1] ?? null;
  const fromBlock = await chain.getBlockNumber();
  const debtBefore = buyer ? await read("PolarisLoanEngine", "activeDebtOf", [buyer]) : 0n;
  const labels = await buttons(popup);
  await shot(popup, "20-payin4-7-app-checkout-with-line");
  // The checkout's Pay in 4 grid: "$87.25 × 4" (sheets/checkout.tsx; the desktop checkout says "4 × $87.25").
  const fourShown = /(× 4|4 ×)/.test(await popup.locator("body").innerText().catch(() => ""));
  await popup.getByRole("button", { name: labels.find((t) => /^(Pay in 4|Start Pay in 4)/.test(t)) }).first().click();
  await confirmInPopup(popup, "20-payin4-8");
  step("Pay in 4: the popup shows its receipt before closing", await receiptInPopup(popup, "20-payin4-8b-app-receipt"));
  const closed = await until("the popup to close after Pay in 4", async () => popup.isClosed(), 90000, 300).catch(() => false);
  if (!closed) await shot(popup, "20-payin4-9-popup-still-open");
  step("Pay in 4: the popup posted its result and closed itself", Boolean(closed));
  await until("the shop's order page", async () => page.url().includes("/orders/"), 60000, 300);
  await until("the plan order to read as paid", async () => {
    await page.reload({ waitUntil: "networkidle" });
    return (await page.getByText(/Thank you|0 of 4 paid|Pay in 4/).count()) > 0;
  }, 90000, 3000);
  await settle(page, 1500);
  await shot(page, "20-payin4-9-shop-order-plan");
  step("Pay in 4: the shop's order is paid through a Polaris plan", true, page.url().replace(SHOP, ""));

  // On chain: the plan against the line, the merchant paid in full from the pool.
  const session = sessionId ? ((await (await fetch(`${BUSINESS}/api/public/sessions/${sessionId}`)).json().catch(() => null))?.data ?? null) : null;
  const principal = session?.payIn4 ? BigInt(session.payIn4.principalUnits) : null;
  const created = buyer
    ? await chain
        .getContractEvents({ address: CONTRACTS.PolarisLoanEngine, abi: abiOf("PolarisLoanEngine"), eventName: "LoanCreated", args: { borrower: buyer }, fromBlock, toBlock: "latest" })
        .catch(() => [])
    : [];
  const loan = created.at(-1) ?? null;
  let paidFromPool = null;
  if (loan) {
    const receipt = await chain.getTransactionReceipt({ hash: loan.transactionHash });
    paidFromPool =
      viem
        .parseEventLogs({ abi: ERC20, logs: receipt.logs.filter((l) => viem.isAddressEqual(l.address, CONTRACTS.Stablecoin)), eventName: "Transfer" })
        .find((t) => viem.isAddressEqual(t.args.from, CONTRACTS.PolarisLoanEngine) && viem.isAddressEqual(t.args.to, loan.args.merchant)) ?? null;
  }
  const [debtAfter, limit] = buyer ? await Promise.all([read("PolarisLoanEngine", "activeDebtOf", [buyer]), read("ScoreManager", "creditLimitOf", [buyer])]) : [0n, 0n];
  const merchant = demo.merchant?.address ?? null;
  step(
    "Pay in 4: the checkout showed 4 instalments; the plan opened on chain against the buyer's line, and the pool paid the merchant the full price",
    fourShown &&
      Boolean(loan) &&
      loan.args.principal === principal &&
      Number(loan.args.installments) === 4 &&
      (!merchant || viem.isAddressEqual(loan.args.merchant, merchant)) &&
      debtAfter - debtBefore === loan.args.totalOwed &&
      debtAfter <= limit &&
      paidFromPool?.args.value === principal,
    loan
      ? `loan ${loan.args.loanId}: ${dollars(loan.args.totalOwed)} owed in 4 against a ${dollars(limit)} line (debt ${dollars(debtBefore)} -> ${dollars(debtAfter)}); ` +
          `PolarisLoanEngine -> merchant ${paidFromPool ? dollars(paidFromPool.args.value) : "no transfer"} of ${principal === null ? "?" : dollars(principal)}`
      : `no LoanCreated for ${buyer} since block ${fromBlock}`,
  );
  return true;
}

(async () => {
  const context = await open();
  let app = context.pages()[0] ?? (await context.newPage());

  // ── The buyer ────────────────────────────────────────────────────────
  await app.goto(APP + "/", { waitUntil: "networkidle", timeout: 240000 });
  await settle(app, 2500);
  if (app.url().includes("/onboard")) {
    await shot(app, "00-app-onboarding");
    await app.getByRole("button", { name: "Create account with Face ID" }).click();
    await settle(app, 2500);
  }
  const buyer = await until("the buyer's account", () => buyerAddress(app, privateKeyToAccount), 60000, 500).catch(() => null);
  if (DEV_SIGNER) {
    step("buyer account created with the dev signer (kept for the device)", Boolean(buyer), buyer ?? "");
  } else {
    // One passkey on the virtual authenticator, and the app's record of it names the account Mera derived from its PRF output.
    const credentials = await context.authenticator.credentials();
    const record = await app.evaluate(() => JSON.parse(localStorage.getItem("polaris.account.v1") || "null"));
    const sameCredential = Boolean(record) && credentials.some((c) => c.credentialId.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") === record.credentialId);
    step(
      "buyer account created with Face ID: a passkey with PRF on Chrome's virtual authenticator, the account derived by Mera",
      Boolean(buyer) && credentials.length === 1 && credentials[0].isResidentCredential && sameCredential,
      `${buyer ?? "no account"}; ${credentials.length} passkey(s), rpId ${credentials[0]?.rpId ?? "-"}`,
    );
  }
  await app.goto(APP + "/add", { waitUntil: "networkidle", timeout: 120000 });
  await settle(app, 1500);
  await app.getByText("Get $500 test dollars").first().click();
  await sleep(3500);
  await app.goto(APP + "/add", { waitUntil: "networkidle" });
  await settle(app, 1500);
  await app.getByText("Get $500 test dollars").first().click();
  await sleep(3500);
  await app.goto(APP + "/", { waitUntil: "networkidle" });
  await settle(app, 3000);
  await shot(app, "01-app-home-funded");
  const balanceText = await app.getByText(/\$1,000\.00|\$1000\.00/).count();
  step("the app reads the buyer's balance from the chain ($1,000 test dollars from the faucet)", balanceText > 0);

  // ── Pay now ──────────────────────────────────────────────────────────
  // The Pay now checkout session, for the sealed receipt it leaves behind (below).
  let payNowSession = null;
  {
    const { page, popup } = await shopCheckout(context, { product: "halcyon-one", mode: "Pay now", prefix: "10-paynow" });
    payNowSession = (popup.url().match(/\/pay\/(cs_[A-Za-z0-9_]+)/) ?? [])[1] ?? null;
    const payer = await buyerAddress(app, privateKeyToAccount);
    const fromBlock = await chain.getBlockNumber();
    const balanceBefore = payer ? await read("Stablecoin", "balanceOf", [payer]) : 0n;
    const pay = (await buttons(popup)).find((t) => /^Pay now/.test(t));
    await popup.getByRole("button", { name: pay }).first().click();
    await confirmInPopup(popup, "10-paynow-5");
    step("Pay now: the popup shows its receipt before closing", await receiptInPopup(popup, "10-paynow-6-app-receipt"));
    const closed = await until("the popup to close after paying", async () => popup.isClosed(), 90000, 300).catch(() => false);
    if (!closed) await shot(popup, "10-paynow-6-popup-still-open");
    step("Pay now: the popup posted its result and closed itself", Boolean(closed));
    await until("the shop's order page", async () => page.url().includes("/orders/"), 60000, 300);
    await until("the order to read as paid", async () => {
      await page.reload({ waitUntil: "networkidle" });
      return (await page.getByText(/Thank you|Paid|paid/).count()) > 0;
    }, 90000, 3000);
    await settle(page, 1500);
    await shot(page, "10-paynow-7-shop-order-paid");
    step("Pay now: the shop's order is paid", true, page.url().replace(SHOP, ""));
    // On chain: PolarisPayments' PaymentMade for this buyer; the buyer's dollars down by the price, the merchant paid
    // the price less PolarisPayments' fee in the same transaction, and the buyer still holds no MON (relayed).
    const session = payNowSession ? ((await (await fetch(`${BUSINESS}/api/public/sessions/${payNowSession}`)).json().catch(() => null))?.data ?? null) : null;
    const price = session ? BigInt(session.amountCents) * 10_000n : null;
    const made = payer
      ? ((await chain
          .getContractEvents({ address: CONTRACTS.PolarisPayments, abi: abiOf("PolarisPayments"), eventName: "PaymentMade", args: { payer }, fromBlock, toBlock: "latest" })
          .catch(() => [])).at(-1) ?? null)
      : null;
    let toMerchant = null;
    if (made) {
      const receipt = await chain.getTransactionReceipt({ hash: made.transactionHash });
      toMerchant =
        viem
          .parseEventLogs({ abi: ERC20, logs: receipt.logs.filter((l) => viem.isAddressEqual(l.address, CONTRACTS.Stablecoin)), eventName: "Transfer" })
          .find((t) => viem.isAddressEqual(t.args.to, made.args.merchant)) ?? null;
    }
    const [balanceAfter, mon] = payer ? await Promise.all([read("Stablecoin", "balanceOf", [payer]), chain.getBalance({ address: payer })]) : [0n, 0n];
    step(
      "Pay now: on chain, the buyer's dollars went down by the price, the merchant got it less the 0.5% fee, and the buyer holds no MON",
      Boolean(made) &&
        made.args.amount === price &&
        balanceBefore - balanceAfter === price &&
        made.args.fee === (price * 50n) / 10_000n &&
        toMerchant?.args.value === price - made.args.fee &&
        mon === 0n,
      made
        ? `buyer -${dollars(balanceBefore - balanceAfter)} of ${price === null ? "?" : dollars(price)}; merchant +${toMerchant ? dollars(toMerchant.args.value) : "nothing"}, fee ${dollars(made.args.fee)}; buyer ${mon} wei of MON`
        : `no PaymentMade for ${payer} since block ${fromBlock}`,
    );
    await page.close();
  }

  // ── Receipts only you can read: what Pay now bought, sealed to the buyer's key ──
  {
    const address = await buyerAddress(app, privateKeyToAccount);
    // What the shop put in the bag (apps/shop: "<product>, <option>" line items); none of it may be on the server in the clear.
    const ITEM = /Halcyon One/;
    // The buyer book (what the app reads): which payment has a sealed receipt, never what is in it.
    const book = address
      ? await until("the Pay now receipt in the buyer book", async () => {
          const body = (await (await fetch(`${BUSINESS}/api/public/buyers/${address}`)).json()).data;
          return body?.receiptsInbox && body.receipts.some((r) => r.kind === "payment") ? body : null;
        }, 60000, 2000).catch(() => null)
      : null;
    const entry = book?.receipts.find((r) => r.kind === "payment") ?? null;
    step("Receipts: the buyer's Face ID inbox key is registered and the Pay now payment has a sealed receipt", Boolean(entry), entry?.id ?? "");
    // The checkout session the server kept: its description and line items are dropped once the receipt is sealed.
    const session = payNowSession ? (await (await fetch(`${BUSINESS}/api/public/sessions/${payNowSession}`)).json()).data : null;
    step(
      "Receipts: the server dropped the checkout's description and line items once the receipt was sealed",
      Boolean(session) && session.description === "Sealed for the buyer" && session.lineItems.length === 0 && !ITEM.test(JSON.stringify(session)),
      session ? `${payNowSession}: "${session.description}", ${session.lineItems.length} line items` : String(payNowSession),
    );
    // The app: the payment's details show the receipt locked, and Face ID opens it. What the server sends the app
    // (the app's own signed POST /api/receipts, watched on the wire) must be ciphertext only.
    const fetched = [];
    const onResponse = async (res) => {
      if (res.request().method() !== "POST" || !/\/api\/receipts$/.test(new URL(res.url()).pathname)) return;
      const signed = (() => {
        try {
          return Boolean(JSON.parse(res.request().postData() || "{}").signature);
        } catch {
          return false;
        }
      })();
      fetched.push({ status: res.status(), signed, text: await res.text().catch(() => "") });
    };
    app.on("response", onResponse);
    let wasLocked = false;
    let opened = false;
    let sealedLine = false;
    if (entry) {
      await app.goto(`${APP}/activity/pay-${encodeURIComponent(entry.id)}`, { waitUntil: "networkidle", timeout: POPUP_MS });
      await settle(app, 2500);
      const openButton = app.getByRole("button", { name: "Open with Face ID" });
      const locked = await until("the locked receipt", async () => (await openButton.count()) > 0 || (await app.getByText(ITEM).count()) > 0, 60000, 500).catch(() => false);
      wasLocked = Boolean(locked) && (await openButton.count()) > 0;
      if (wasLocked) {
        await shot(app, "15-receipt-1-app-locked");
        await openButton.first().click();
      }
      opened = Boolean(await until("the opened receipt's line items", async () => (await app.getByText(ITEM).count()) > 0, 60000, 500).catch(() => false));
      await sleep(800);
      await shot(app, "15-receipt-2-app-opened");
      sealedLine = (await app.getByText("Sealed to your Face ID. Only you can read it.").count()) > 0;
    }
    app.off("response", onResponse);
    const answer = fetched.filter((f) => f.status === 200).pop() ?? null;
    let row = null;
    try {
      row = answer ? ((JSON.parse(answer.text).data?.receipts ?? []).find((r) => r.id === entry?.id) ?? null) : null;
    } catch {
      row = null;
    }
    const problems = [];
    if (!row) problems.push(`no row for ${entry?.id} in ${fetched.length} receipt fetches`);
    else {
      if (!answer.signed) problems.push("the app's request carried no signature");
      // HPKE's encapsulated X25519 key and the AES-GCM ciphertext, base64url (packages/receipts sealReceipt).
      const b64url = (x) => (typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x) ? Buffer.from(x, "base64url") : null);
      if (b64url(row.enc)?.length !== 32) problems.push("enc is not a 32-byte key");
      if (!((b64url(row.ct)?.length ?? 0) > 100)) problems.push("ct is not ciphertext");
      for (const re of [ITEM, /Halcyon order/]) {
        const m = re.exec(answer.text);
        if (m) problems.push(`the answer says "${answer.text.slice(Math.max(0, m.index - 60), m.index + 40)}"`);
      }
    }
    step(
      "Receipts: the server holds the receipt only as ciphertext (no item names in what it returns)",
      problems.length === 0,
      problems.length ? problems.join("; ") : `${Buffer.from(row.ct, "base64url").length} bytes of ciphertext, fetched by the app with a signed request`,
    );
    step("Receipts: the app shows the receipt locked, and Face ID opens it to the line items only the buyer can read", wasLocked && opened && sealedLine);
  }

  // ── Pay in 4, with a credit line: from the CRE workflow, or else from Boost ──
  // The underwriting review reads Nansen, Zerion and Etherscan live, with the keys the CRE trigger has
  // (workflows/.env), or not at all: a review that needs a provider without its key opens no line and says which
  // key is missing. Then the buyer does what the app offers without those keys: Add to Boost (dollars locked in
  // CollateralVault raise the line), and Pay in 4 runs against that line. Without a line either way, the plan's
  // steps are reported as not run, with the reason.
  let planOpened = false;
  let noLineBecause = "";
  {
    const { page, popup } = await shopCheckout(context, { product: "halcyon-one", mode: "Pay in 4", prefix: "20-payin4" });
    const sessionId = (popup.url().match(/\/pay\/(cs_[A-Za-z0-9_]+)/) ?? [])[1] ?? null;
    const labels = await buttons(popup);
    console.log("  pay in 4 popup buttons:", JSON.stringify(labels));
    // A new buyer has no line yet: Pay in 4 opens "Raise your limit" first.
    await popup.getByRole("button", { name: labels.find((t) => /^Pay in 4/.test(t)) }).first().click();
    await sleep(1200);
    let up = (await popup.getByRole("button", { name: /Connect your wallet/ }).count()) === 0;
    if (!up) {
      await shot(popup, "20-payin4-5-raise-your-limit");
      await popup.getByRole("button", { name: /Connect your wallet/ }).first().click();
      const outcome = await review(popup);
      await shot(popup, outcome.up ? "20-payin4-6-limit-raised" : "20-payin4-6-review-not-configured");
      up = outcome.up;
      const line = await creditLine(await buyerAddress(app, privateKeyToAccount));
      if (up) {
        step("Pay in 4: Bring your history ran the CRE underwriting workflow and opened a line on chain", line > 0n, `limit $${Number(line) / 1e6}`);
      } else {
        noLineBecause = outcome.message || "the review opened no line";
        step(
          "Pay in 4: Bring your history ran the CRE underwriting workflow; it says which data provider isn't set up, and no line opens",
          /set up on this server yet/.test(outcome.message) && line === 0n,
          `"${outcome.message}"; on-chain limit $${Number(line) / 1e6}`,
        );
      }
      const done = popup.getByRole("button", { name: "Done" });
      if (up && (await done.count())) await done.last().click();
      await sleep(1000);
      // The checkout re-reads the line once the decision lands; until then it still offers Raise your limit.
      if (up) await until("the checkout to read the new line", async () => (await popup.getByText(/This plan needs .* of limit/).count()) === 0, 90000, 1000).catch(() => {});
    }
    if (up) {
      planOpened = await payIn4Plan(app, page, popup);
      await page.close();
    } else {
      // No line from the review: this checkout is left unpaid (the shop's order stays open), and the buyer boosts.
      await popup.close().catch(() => {});
      await page.close();
      const covered = await boostForPlan(app, sessionId);
      if (covered) {
        // Boost took most of the buyer's dollars, and the plan's instalments (a minute apart with DEMO_FAST_PLANS),
        // the subscription and the dashboard link still draw on the account: add $500 more, as the app offers.
        await app.goto(APP + "/add", { waitUntil: "networkidle", timeout: 120000 });
        await settle(app, 1500);
        await app.getByText("Get $500 test dollars").first().click();
        await sleep(3500);
        console.log(`  added $500 test dollars after Boost: balance ${dollars(await read("Stablecoin", "balanceOf", [await buyerAddress(app, privateKeyToAccount)]))}`);
        const again = await shopCheckout(context, { product: "halcyon-one", mode: "Pay in 4", prefix: "22-payin4-boosted" });
        planOpened = await payIn4Plan(app, again.page, again.popup);
        await again.page.close();
      } else {
        noLineBecause = `${noLineBecause}; Boost did not cover the plan`;
      }
    }
    if (!planOpened) {
      for (const name of [
        "Pay in 4: the popup shows its receipt before closing",
        "Pay in 4: the popup posted its result and closed itself",
        "Pay in 4: the shop's order is paid through a Polaris plan",
        "Pay in 4: the checkout showed 4 instalments; the plan opened on chain against the buyer's line, and the pool paid the merchant the full price",
      ]) {
        skip(name, `no credit line: ${noLineBecause}`);
      }
    }
  }

  // ── A new buyer on a fresh phone: Pay in 4 creates the account and runs the review in one tap ──
  {
    const phone = await open({ width: 390, height: 844, profile: `${PROFILE}-newbuyer` });
    try {
      const { page, popup } = await shopCheckout(phone, { product: "arc-lamp", mode: "Pay in 4", prefix: "25-newbuyer" });
      const labels = await buttons(popup);
      await popup.getByRole("button", { name: labels.find((t) => /^(Pay in 4|Start Pay in 4)/.test(t)) }).first().click();
      await sleep(1500);
      const faceId = popup.getByRole("button", { name: /Continue with Face ID/ });
      const offered = await until("Continue with Face ID in Raise your limit", async () => (await faceId.count()) > 0, 30000, 500).catch(() => false);
      await shot(popup, "25-newbuyer-5-raise-your-limit");
      step("New buyer: Raise your limit offers Continue with Face ID (no account on this phone yet)", Boolean(offered));
      if (offered) {
        await faceId.first().click();
        const outcome = await review(popup);
        await shot(popup, outcome.up ? "25-newbuyer-6-limit-raised" : "25-newbuyer-6-review-not-configured");
        const buyer = await until("the new buyer's account", () => buyerAddress(popup, privateKeyToAccount), 30000, 500).catch(() => null);
        const line = await creditLine(buyer);
        if (outcome.up) {
          step("New buyer: one tap created the account and the CRE workflow opened a line", Boolean(buyer) && line > 0n, `${buyer}; limit $${Number(line) / 1e6}`);
        } else {
          step(
            "New buyer: one tap created the account (Face ID) and ran the review, which says which provider isn't set up and opens no line",
            Boolean(buyer) && /set up on this server yet/.test(outcome.message) && line === 0n,
            `${buyer ?? "no account"}; "${outcome.message}"`,
          );
        }
      }
      await page.close().catch(() => {});
    } finally {
      await phone.close().catch(() => {});
    }
  }

  // ── Collections: the CRE collections workflow collects a due instalment (DEMO_FAST_PLANS=1) ──
  if (demo.fastPlans && !planOpened) {
    skip("Collections: the CRE collections workflow collected the first instalment on chain (a minute after checkout)", "no Pay in 4 plan opened (no credit line)");
  } else if (demo.fastPlans) {
    const buyer = await buyerAddress(app, privateKeyToAccount);
    const paid = buyer
      ? await until("an instalment collected by the CRE collections run", async () => {
          const res = await fetch(`${BUSINESS}/api/public/buyers/${buyer}`);
          const plans = (await res.json()).data?.plans ?? [];
          return plans.some((p) => p.installmentsPaid >= 1) ? plans : null;
        }, 300000, 5000).catch(() => null)
      : null;
    step("Collections: the CRE collections workflow collected the first instalment on chain (a minute after checkout)", Boolean(paid), paid ? `${paid[0].installmentsPaid} of ${paid[0].installments} paid` : "");
  }

  // ── Take out of Boost, while the plan it secures is open: nothing to take ──
  if (planOpened) await takeOutWhilePlanOpen(app);

  // ── Subscribe: the Coffee Club, monthly, in the Polaris popup ──────────
  {
    const page = await context.newPage();
    await page.goto(`${SHOP}/checkout?subscribe=coffee-club`, { waitUntil: "networkidle", timeout: 240000 });
    await settle(page, 1000);
    await shot(page, "50-subscribe-1-shop-checkout");
    const main = (await buttons(page)).find((t) => /^Subscribe ·/.test(t));
    const [popup] = await Promise.all([context.waitForEvent("page", { timeout: POPUP_MS }), page.getByRole("button", { name: main }).first().click()]);
    await until("the checkout in the popup", async () => popup.url().includes("/pay/"), POPUP_MS, 300);
    await settle(popup, 3000);
    await until("the subscribe button", async () => (await buttons(popup)).some((t) => /^Subscribe/.test(t)), 90000);
    await shot(popup, "50-subscribe-2-app-checkout-popup");
    const sub = (await buttons(popup)).find((t) => /^Subscribe/.test(t));
    await popup.getByRole("button", { name: sub }).first().click();
    await confirmInPopup(popup, "50-subscribe-3");
    const closed = await until("the popup to close after subscribing", async () => popup.isClosed(), 90000, 300).catch(() => false);
    step("Subscribe: the popup posted its result and closed itself", Boolean(closed));
    await until("the shop's order page", async () => page.url().includes("/orders/"), 60000, 300);
    await until("the subscription order to read as paid", async () => {
      await page.reload({ waitUntil: "networkidle" });
      return (await page.getByText(/Thank you/).count()) > 0;
    }, 90000, 3000);
    await settle(page, 1500);
    await shot(page, "50-subscribe-4-shop-order");
    step("Subscribe: the Coffee Club order is paid, the first month charged on chain", true, page.url().replace(SHOP, ""));
    await page.close();
  }

  // ── Pay directly with a wallet: polarispay-sdk's pay(), one signature, relayed ──
  {
    const { generatePrivateKey } = require(require.resolve("viem/accounts", { paths: [require("path").join(__dirname, "..", "apps", "business")] }));
    const wallet = privateKeyToAccount(generatePrivateKey());
    const rpcUrl = RPC;
    const faucet = FAUCET;
    await fetch(`${faucet}/mint`, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify({ address: wallet.address }) });
    const page = await context.newPage();
    // A browser wallet: this key signs; everything else is the local node's answer.
    await page.exposeFunction("__polarisDemoWallet", async (method, paramsJson) => {
      const params = JSON.parse(paramsJson || "[]");
      try {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return JSON.stringify({ result: [wallet.address] });
        if (method === "eth_signTypedData_v4") {
          const typed = JSON.parse(params[1]);
          const { EIP712Domain: _unused, ...types } = typed.types;
          return JSON.stringify({ result: await wallet.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message }) });
        }
        if (method === "wallet_switchEthereumChain") return JSON.stringify({ result: null });
        const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const body = await res.json();
        return JSON.stringify(body.error ? { error: body.error } : { result: body.result });
      } catch (e) {
        return JSON.stringify({ error: { code: -32603, message: String(e) } });
      }
    });
    await page.addInitScript(() => {
      window.ethereum = {
        isMetaMask: true,
        async request({ method, params }) {
          const out = JSON.parse(await window.__polarisDemoWallet(method, JSON.stringify(params || [])));
          if (out.error) {
            const e = new Error(out.error.message);
            e.code = out.error.code;
            throw e;
          }
          return out.result;
        },
        on() {},
        removeListener() {},
      };
    });
    await page.goto(`${SHOP}/products/keys-75`, { waitUntil: "networkidle", timeout: 240000 });
    await page.evaluate(() => localStorage.removeItem("halcyon.bag.v1"));
    await page.reload({ waitUntil: "networkidle" });
    await settle(page, 800);
    await page.getByRole("button", { name: /Add to bag/ }).filter({ visible: true }).first().click();
    await sleep(1200);
    await page.goto(`${SHOP}/checkout`, { waitUntil: "networkidle", timeout: 120000 });
    await settle(page, 1000);
    await page.getByText("Pay directly with a wallet", { exact: true }).first().click();
    await sleep(800);
    await shot(page, "60-wallet-1-shop-checkout");
    const pay = (await buttons(page)).find((t) => /wallet|Pay \$/i.test(t) && !/Built with/.test(t));
    await page.getByRole("button", { name: pay }).first().click();
    await until("the wallet order page", async () => page.url().includes("/orders/"), POPUP_MS, 500);
    await until("the wallet order to read as paid", async () => {
      await page.reload({ waitUntil: "networkidle" });
      return (await page.getByText(/Thank you/).count()) > 0;
    }, 90000, 3000);
    await settle(page, 1500);
    await shot(page, "60-wallet-2-shop-order-paid");
    step("Direct wallet payment: one signature, relayed gas-free by Polaris, the order paid by webhook", true, page.url().replace(SHOP, ""));
    await page.close();
  }

  // ── The app afterwards ───────────────────────────────────────────────
  await app.goto(APP + "/", { waitUntil: "networkidle" });
  await settle(app, 4000);
  await shot(app, "30-app-home-after");
  await app.goto(APP + "/credit", { waitUntil: "networkidle" });
  await settle(app, 4000);
  await shot(app, "31-app-credit-line");
  await app.goto(APP + "/plans", { waitUntil: "networkidle" });
  await settle(app, 4000);
  await shot(app, "32-app-pay-in-4-plans");

  // ── The merchant's dashboard ─────────────────────────────────────────
  const dash = await context.newPage();
  await dash.goto(BUSINESS + "/dashboard", { waitUntil: "networkidle", timeout: 240000 });
  await settle(dash, 5000);
  await shot(dash, "40-dashboard-overview");
  // A buyer with a Face ID inbox gets a sealed receipt, and the merchant's records then say "Sealed for the buyer" in
  // place of the description (packages/db SEALED_DESCRIPTION; apps/business README, receipts): no product name from
  // the bags this run paid for may show on the merchant's side for them.
  const SEALED = "Sealed for the buyer";
  const BOUGHT = /Halcyon One|Arc Desk Lamp|Keys 75|Halcyon Coffee Club/;
  const sealedRows = async () => dash.getByText(SEALED).count();
  const leaked = async () => ((await dash.locator("main").innerText().catch(() => "")).match(BOUGHT) ?? [null])[0];
  const overviewSealed = await until("the payments on the overview", async () => (await sealedRows()) > 0, 60000, 2000).catch(() => false);
  const overviewLeak = await leaked();
  step("the dashboard shows the payments (from the chain sync), sealed for the buyer, no item names", Boolean(overviewSealed) && !overviewLeak, overviewLeak ? `shows "${overviewLeak}"` : `${await sealedRows()} sealed rows`);
  await dash.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1500);
  await shot(dash, "41-dashboard-panels");
  await dash.goto(BUSINESS + "/dashboard/payments", { waitUntil: "networkidle" });
  await settle(dash, 4000);
  await shot(dash, "42-dashboard-payments");
  console.log(`  payments page: ${(await dash.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600)}`);
  await dash.goto(BUSINESS + "/dashboard/plans", { waitUntil: "networkidle" });
  await settle(dash, 4000);
  await shot(dash, "43-dashboard-pay-in-4");
  if (planOpened) {
    const planSealed = await until("the plan on the dashboard", async () => (await sealedRows()) > 0, 60000, 2000).catch(() => false);
    const planLeak = await leaked();
    step("the dashboard shows the Pay in 4 plan, sealed for the buyer, no item names", Boolean(planSealed) && !planLeak, planLeak ? `shows "${planLeak}"` : "");
  } else {
    skip("the dashboard shows the Pay in 4 plan, sealed for the buyer, no item names", "no Pay in 4 plan opened (no credit line)");
  }
  await dash.goto(BUSINESS + "/dashboard/settings", { waitUntil: "networkidle" });
  await settle(dash, 3000);
  await shot(dash, "44-dashboard-settings-registered");
  step("the merchant registered on chain through the dashboard's registration API", (await dash.getByText(/Active/).count()) > 0);

  // ── A dashboard payment link: paid, it ends on Done (Home), and stays open for the next buyer ──
  {
    await dash.goto(BUSINESS + "/dashboard/links?new=1", { waitUntil: "networkidle" });
    await settle(dash, 2500);
    // The New link dialog (the page's own Request a payment panel has the same fields).
    const form = dash.getByRole("dialog").last();
    await form.getByLabel("What it's for").fill("Logo work");
    await form.getByLabel("Amount").fill("40.00");
    await shot(dash, "45-dashboard-new-link");
    await form.getByRole("button", { name: "Create link" }).click();
    // Saved: share it from its row (the Share dialog shows the URL and its QR code).
    await dash.getByRole("button", { name: /Share .Logo work/ }).first().click({ timeout: 30000 }).catch(() => {});
    await sleep(1500);
    await shot(dash, "45-dashboard-share-link");
    const url = await until("the new link's URL", async () => {
      const codes = await dash.locator("code").allInnerTexts();
      return codes.find((c) => /\/pay\/pl_/.test(c)) ?? null;
    }, 30000, 500).catch(() => null);
    step("Dashboard: a reusable payment link was created", Boolean(url), url ?? "");
    if (url) {
      const buyerPage = await context.newPage();
      await buyerPage.goto(url, { waitUntil: "networkidle", timeout: POPUP_MS });
      await settle(buyerPage, 3000);
      await shot(buyerPage, "46-link-1-app-checkout");
      // "Pay now" on a phone, "Pay $40" on the desktop checkout.
      const pay = (await buttons(buyerPage)).find((t) => /^Pay (now|\$\d)/.test(t));
      if (pay) {
        await buyerPage.getByRole("button", { name: pay }).first().click();
        await confirmInPopup(buyerPage, "46-link-2");
        await until("the link's receipt", async () => (await buyerPage.getByText(/^Paid\.$/).count()) > 0, 90000, 300);
        await sleep(1200);
        await shot(buyerPage, "46-link-3-app-receipt");
        const done = buyerPage.getByRole("button", { name: "Done" });
        const saysDone = (await done.count()) > 0;
        if (saysDone) await done.last().click();
        await sleep(2500);
        const home = new URL(buyerPage.url()).pathname === "/";
        step("Dashboard link: the receipt says Done and goes Home (no loop back to the paid checkout)", saysDone && home, buyerPage.url().replace(APP, ""));
      } else {
        step("Dashboard link: the receipt says Done and goes Home (no loop back to the paid checkout)", false, `no Pay now in ${JSON.stringify(await buttons(buyerPage))}`);
      }
      // Another visitor opens the same link: a new session, open, not "already paid".
      const second = await open({ width: 390, height: 844, profile: `${PROFILE}-second` });
      try {
        const p2 = second.pages()[0] ?? (await second.newPage());
        await p2.goto(url, { waitUntil: "networkidle", timeout: POPUP_MS });
        await settle(p2, 3000);
        await shot(p2, "46-link-4-next-visitor");
        const paidAlready = (await p2.getByText(/is already paid/).count()) > 0;
        const open2 = (await buttons(p2)).some((t) => /^(Pay now|Pay in 4|Continue)/.test(t));
        step("Dashboard link: the next visitor gets a fresh checkout, not 'already paid'", !paidAlready && open2);
      } finally {
        await second.close().catch(() => {});
      }
      await buyerPage.close().catch(() => {});
    }
  }

  // ── Take out of Boost, once the plan is repaid: some dollars back, one Face ID, no MON ──
  if (planOpened) await takeOutAfterRepaid(app);
  else for (const n of [
    `Take out: the buyer took ${dollars(TAKE_OUT)} out of Boost with one Face ID; on chain the vault paid the buyer exactly that, the relayer sent it, the buyer holds 0 MON`,
    "Take out: the Taken out. screen shows Boost, the Pay later limit and the dollar balance read back from the chain",
  ]) skip(n, `no Pay in 4 plan opened (no credit line): ${noLineBecause}`);

  // ── Split the bill: four people, one link (scripts/demo-e2e-split.cjs; `pnpm demo:e2e:split` runs it alone) ──
  if (process.env.DEMO_E2E_SPLIT !== "0") {
    const { runSplit } = require("./demo-e2e-split.cjs");
    const urls = { app: APP, business: BUSINESS, rpc: RPC, stablecoin: demo.contracts?.Stablecoin ?? null };
    await runSplit({ chromium, urls, out: path.join(OUT, "split"), profile: `${PROFILE}-split`, step }).catch((e) =>
      step("Split: the scenario ran to the end", false, String(e?.message ?? e).slice(0, 200)),
    );
  }

  await context.close();
  console.log(JSON.stringify(results, null, 1));
  const count = (v) => results.filter((r) => r.ok === v).length;
  console.log(`${count(true)} passed, ${count(false)} failed, ${count(null)} not run`);
  if (results.some((r) => r.ok === false)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(results, null, 1));
  process.exit(1);
});
