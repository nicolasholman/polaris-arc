#!/usr/bin/env node
// Split the bill, end to end and headless, against a running `pnpm demo:local`:
//
//   PLAYWRIGHT_MODULE=<path to an installed playwright> pnpm demo:e2e:split
//
// Four people, four browser profiles, one local chain (PolarisSplit, relayed by the dev
// relayer under the production policy). Each profile signs in with Face ID: on demo:local's
// fork, the app's own passkey ceremony on Chrome's virtual authenticator with PRF
// (scripts/lib/virtual-authenticator.cjs); on its Hardhat stack, the dev signer:
//
//  1. Maya (a phone, 402x877) paid a $200 dinner for five. She splits it equally, names
//     her four friends and gets one link: $40 each, $160 to collect, her own $40 hers.
//  2. Sam (a desktop, 1440x900, no account) opens the link: "Maya asked you to split",
//     0 of 4 paid. He picks his name and pays; Face ID creates his account in the same
//     step, and he is told to add $40 before anything is signed. He adds test dollars
//     and pays. The same signature relayed again pays nothing more.
//  3. Priya (a phone, with an account and dollars) picks her name and pays.
//  4. Maya sees 2 of 4 paid, and $80 in her account, in Activity on the phone and on the
//     desktop. She closes the split: the two unpaid shares are cancelled.
//  5. Jon opens the link after it closed: nothing to pay, nothing charged.
//  6. On the desktop, Maya splits $90 of groceries by named amounts (Sam $35.50, Priya
//     $24.50). Both pay; the split reads "Everyone paid".
//
// Every amount and status is checked against GET /api/public/splits/{id} (the chain's
// state) and the organiser's balance against the chain. Screenshots at 402x877 and
// 1440x900 go to docs/design/split (OUT to change it), with results.json. Exits 1 if a
// step fails.
//
// `pnpm demo:e2e` runs this scenario too, after its own (require("./demo-e2e-split.cjs")).
// Playwright isn't a dependency of the repo: install it anywhere and point PLAYWRIGHT_MODULE
// at it, or run from a folder where `require("playwright")` resolves. CHROMIUM points at a
// Chrome build when Playwright's own isn't installed.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { addAuthenticator, buyerAddress } = require("./lib/virtual-authenticator.cjs");

const REPO = path.join(__dirname, "..");
const PHONE = { width: 402, height: 877 };
const DESKTOP = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where the running `pnpm demo:local` is: its .demo/demo.json, else APP, BUSINESS, RPC, else the defaults. */
function demoUrls() {
  const file = path.join(REPO, ".demo", "demo.json");
  const demo = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { urls: {}, contracts: {} };
  return {
    app: process.env.APP || demo.urls.app || "http://localhost:3000",
    business: process.env.BUSINESS || demo.urls.business || "http://localhost:3100",
    rpc: process.env.RPC || demo.urls.rpc || "http://127.0.0.1:8545",
    stablecoin: demo.contracts?.Stablecoin ?? null,
    // Hardhat mode's app signs with the dev signer; fork mode's with passkeys (demo.json devSigner false).
    devSigner: demo.devSigner !== false,
  };
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

/**
 * The split scenario. `step(name, ok, detail)` records a result (demo-e2e.cjs passes its
 * own, so the runs report together).
 */
async function runSplit({ chromium, urls = demoUrls(), out, profile, step }) {
  const APP = urls.app;
  const BUSINESS = urls.business;
  fs.mkdirSync(out, { recursive: true });
  const evidence = { splits: {} };
  const { privateKeyToAccount } = require(require.resolve("viem/accounts", { paths: [path.join(REPO, "apps", "business")] }));

  const contexts = [];
  async function open(name, viewport) {
    const context = await chromium.launchPersistentContext(`${profile}-${name}`, {
      headless: true,
      ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
      viewport,
      locale: "en-US",
      timezoneId: "America/New_York",
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    // A first `next dev` compile of a route can take a minute on a slow disk; demo:local warms them.
    context.setDefaultNavigationTimeout(180000);
    context.setDefaultTimeout(30000);
    contexts.push(context);
    const page = context.pages()[0] ?? (await context.newPage());
    // One passkey authenticator per person (per profile), before the app loads.
    if (!urls.devSigner) await addAuthenticator(context, { origin: new URL(APP).origin, log: (line) => console.log(`  [${name}] ${line}`) });
    page.on("pageerror", (e) => console.log(`  [${name} pageerror] ${String(e).slice(0, 240)}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Download the React DevTools|favicon/.test(m.text())) console.log(`  [${name} console] ${m.text().slice(0, 240)}`);
    });
    return { context, page, name };
  }

  async function shot(page, name) {
    await sleep(500);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`  shot ${name}.png`);
  }

  async function settle(page, ms = 1200) {
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await sleep(ms);
  }

  async function goto(page, url) {
    // The same page with another fragment would be a same-document navigation: load it afresh.
    const same = page.url().split("#")[0] === url.split("#")[0];
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (same) await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page, 1500);
  }

  const visible = (page, text) => page.getByText(text).filter({ visible: true });
  const seen = async (page, text) => (await visible(page, text).count()) > 0;
  const waitFor = (page, text, timeoutMs = 60000) => until(`"${text}" on ${page.url()}`, () => seen(page, text), timeoutMs, 400);

  /** The account on this profile: the passkey's (the app's public record of it), or the dev signer's. */
  async function accountOf(page) {
    return buyerAddress(page, privateKeyToAccount);
  }

  async function createAccount(who) {
    await goto(who.page, `${APP}/`);
    if (who.page.url().includes("/onboard")) {
      // A phone shows the three intro pages first; the desktop goes straight to the account.
      const start = who.page.getByRole("button", { name: "Get Started" }).filter({ visible: true });
      if (await start.count()) await start.first().click();
      await who.page.getByRole("button", { name: "Create account with Face ID" }).filter({ visible: true }).first().click();
      await settle(who.page, 2500);
    }
    return until(`${who.name}'s account`, () => accountOf(who.page), 60000, 500);
  }

  async function testDollars(who) {
    const before = await balanceOf(await accountOf(who.page));
    await goto(who.page, `${APP}/add`);
    await visible(who.page, "Get $500 test dollars").first().click();
    return until(`${who.name}'s test dollars`, async () => (await balanceOf(await accountOf(who.page))) > before, 60000, 1000);
  }

  async function rpc(method, params) {
    const res = await fetch(urls.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }

  /** AUSD (6 decimals) held by `address`, read from the chain, in micro-dollars. */
  async function balanceOf(address) {
    if (!address || !urls.stablecoin) return 0n;
    const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
    return BigInt(await rpc("eth_call", [{ to: urls.stablecoin, data }, "latest"]));
  }

  async function splitStatus(id) {
    const res = await fetch(`${BUSINESS}/api/public/splits/${id}`, { headers: { origin: APP } });
    if (!res.ok) throw new Error(`GET /api/public/splits/${id}: ${res.status}`);
    return (await res.json()).data;
  }

  /** The links this device made or opened, as the app keeps them. */
  async function knownSplits(page) {
    return page.evaluate(() => JSON.parse(localStorage.getItem("polaris.splits.v1") || "{}"));
  }

  /** The Face ID confirm (the compact sheet, or the desktop's dialog), optionally naming the organiser first. */
  async function confirm(page, { shotName, name, label = /Face ID/ } = {}) {
    const dialog = page.getByRole("dialog").last();
    const button = dialog.getByRole("button", { name: label }).first();
    await button.waitFor({ timeout: 30000 });
    if (name) {
      const field = dialog.getByLabel(/Your first name/);
      if (await field.count()) await field.fill(name);
    }
    await sleep(900);
    if (shotName) await shot(page, shotName);
    await button.click();
  }

  /** On the link: pick a named share (named splits), then Pay $X. */
  async function pickAndPay(who, label, { shotPicked, shotConfirm } = {}) {
    await waitFor(who.page, "Which one is you?");
    await who.page.getByRole("button", { name: new RegExp(`^${label}\\b`) }).filter({ visible: true }).first().click();
    await sleep(600);
    if (shotPicked) await shot(who.page, shotPicked);
    await who.page.getByRole("button", { name: /^Pay \$/ }).filter({ visible: true }).first().click();
    await confirm(who.page, { shotName: shotConfirm });
  }

  const relayed = [];
  function recordRelays(who) {
    who.page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/api/relay")) {
        try {
          const body = JSON.parse(req.postData() || "{}");
          if (body.type === "payShare" || body.type === "createSplit" || body.type === "closeSplit") relayed.push({ who: who.name, body });
        } catch {
          /* not JSON */
        }
      }
    });
  }

  try {
    // ── 1. Maya splits the dinner, on her phone ─────────────────────────────
    const maya = await open("maya", PHONE);
    recordRelays(maya);
    const mayaAddress = await createAccount(maya);
    step(`Split: Maya has an account (${urls.devSigner ? "dev signer for Face ID" : "Face ID: a passkey with PRF"}), and no dollars`, Boolean(mayaAddress), mayaAddress ?? "");
    const mayaBefore = await balanceOf(mayaAddress);

    await goto(maya.page, `${APP}/split/new`);
    await waitFor(maya.page, "What did the bill come to?");
    const keypad = maya.page.getByRole("group", { name: "Keypad" });
    for (const k of ["2", "0", "0"]) await keypad.getByRole("button", { name: k, exact: true }).click();
    await shot(maya.page, "01-phone-new-bill");
    await maya.page.getByRole("button", { name: "Next" }).click();
    await maya.page.getByLabel("What's it for").fill("Dinner at Lucia");
    const more = maya.page.getByRole("button", { name: "One more" });
    await more.click();
    await more.click();
    const friends = ["Sam", "Priya", "Jon", "Dee"];
    for (const [i, n] of friends.entries()) await maya.page.getByLabel(`Friend ${i + 1}'s name`).fill(n);
    await maya.page.getByLabel("What's it for").click();
    await shot(maya.page, "02-phone-new-details");
    const planned = (await seen(maya.page, "$40.00")) && (await seen(maya.page, "$160.00"));
    step("Split: $200 between five, Maya included: four friends owe $40 each, $160 to collect", planned);
    await maya.page.getByRole("button", { name: /^Create link for \$160/ }).click();
    await confirm(maya.page, { name: "Maya", shotName: "03-phone-new-confirm" });
    await waitFor(maya.page, "Link ready.", 90000);
    await shot(maya.page, "04-phone-link-ready");
    const known = await knownSplits(maya.page);
    const [dinnerId, dinnerKnown] = Object.entries(known).find(([, v]) => v.role === "organiser") ?? [];
    const dinnerUrl = dinnerKnown?.url;
    step("Split: one link, its words in the fragment", Boolean(dinnerUrl && /\/split\/0x[0-9a-f]{64}#/.test(dinnerUrl) && dinnerUrl.includes("d=Dinner")), dinnerUrl ?? "");
    evidence.splits.dinner = { id: dinnerId, url: dinnerUrl };
    let s = await until("the split on chain", () => splitStatus(dinnerId), 30000, 1000);
    step(
      "Split: PolarisSplit holds it: Maya organises, 4 shares of $40.00, open",
      s.organiser.toLowerCase() === mayaAddress.toLowerCase() && s.status === "open" && s.shareCount === 4 && s.shares.every((x) => x.amountUnits === "40000000") && s.totalUnits === "160000000",
      `created in ${s.createdTxHash ?? "?"}`,
    );
    const words = await fetch(`${BUSINESS}/api/public/splits/${dinnerId}`).then((r) => r.text());
    step("Split: the API never sees the split's words (only their hash)", !/Lucia|Maya|Jon/.test(words));
    await maya.page.getByRole("button", { name: "See your split" }).click();
    await until("the split's own page", async () => maya.page.url().includes(`/split/${dinnerId}`), 180000, 500);
    await waitFor(maya.page, "Collected so far", 120000);
    await waitFor(maya.page, "0 of 4 paid");
    await shot(maya.page, "05-phone-organiser-open");

    // ── 2. Sam, on a desktop with no account ───────────────────────────────
    const sam = await open("sam", DESKTOP);
    recordRelays(sam);
    await goto(sam.page, dinnerUrl);
    await waitFor(sam.page, "Maya asked you to split", 90000);
    await shot(sam.page, "06-desktop-friend-link");
    step("Split: Sam opens the link: who asked, what for, 0 of 4 paid, pick your name", (await seen(sam.page, "Dinner at Lucia")) && (await seen(sam.page, "0 of 4 paid")));
    await pickAndPay(sam, "Sam", { shotPicked: "07-desktop-friend-picked", shotConfirm: "08-desktop-friend-confirm-new" });
    const short = await until("Sam told to add money", async () => (await sam.page.getByRole("alert").filter({ hasText: /Add \$40\.00/ }).count()) > 0, 60000, 400).catch(() => false);
    const samAddress = await accountOf(sam.page);
    await shot(sam.page, "09-desktop-friend-add-first");
    step("Split: Pay with Face ID made Sam's account in the same step, and asked him to add $40.00 before signing anything", Boolean(short && samAddress), samAddress ?? "");
    step("Split: nothing was relayed for Sam's empty account", !relayed.some((r) => r.who === "sam" && r.body.type === "payShare"));
    await sam.page.keyboard.press("Escape");
    await sleep(800);
    await waitFor(sam.page, "Add money, then pay it here.");
    await shot(sam.page, "10-desktop-friend-short");
    await testDollars(sam);
    await goto(sam.page, dinnerUrl);
    await pickAndPay(sam, "Sam", { shotConfirm: "11-desktop-friend-confirm" });
    await waitFor(sam.page, "Paid.", 90000);
    await shot(sam.page, "12-desktop-friend-paid");
    s = await splitStatus(dinnerId);
    step(
      "Split: Sam's $40.00 is share 1, paid by his account",
      s.paidCount === 1 && s.shares[0].paid && s.shares[0].payer?.toLowerCase() === samAddress.toLowerCase(),
      s.shares[0].txHash ?? "",
    );
    step("Split: it went straight to Maya (PolarisSplit keeps nothing)", (await balanceOf(mayaAddress)) - mayaBefore === 40_000_000n);

    // The same signed share, relayed a second time: the relayer answers with the first result; nothing moves.
    const samShare = relayed.find((r) => r.who === "sam" && r.body.type === "payShare");
    if (samShare) {
      const res = await fetch(`${BUSINESS}/api/relay`, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify(samShare.body) });
      const again = await res.json().catch(() => ({}));
      const after = await splitStatus(dinnerId);
      step(
        "Split: the same signature relayed again pays nothing more",
        after.paidCount === 1 && (await balanceOf(mayaAddress)) - mayaBefore === 40_000_000n,
        res.ok ? `same transaction ${again.data?.txHash ?? "?"}` : `refused: ${again.error?.code ?? res.status}`,
      );
    } else {
      step("Split: the same signature relayed again pays nothing more", false, "Sam's payShare request wasn't seen");
    }
    await goto(sam.page, dinnerUrl);
    await waitFor(sam.page, "You paid your share");
    step("Split: back on the link, Sam sees he paid (no second Pay button)", (await sam.page.getByRole("button", { name: /^Pay \$/ }).count()) === 0);

    // ── 3. Priya, on a phone, with an account and dollars ────────────────────
    const priya = await open("priya", PHONE);
    recordRelays(priya);
    const priyaAddress = await createAccount(priya);
    await testDollars(priya);
    await goto(priya.page, dinnerUrl);
    await waitFor(priya.page, "1 of 4 paid", 90000);
    await shot(priya.page, "13-phone-friend-link");
    await pickAndPay(priya, "Priya", { shotPicked: "14-phone-friend-picked", shotConfirm: "15-phone-friend-confirm" });
    await waitFor(priya.page, "Paid.", 90000);
    await shot(priya.page, "16-phone-friend-paid");
    s = await splitStatus(dinnerId);
    step("Split: Priya's $40.00 is share 2", s.paidCount === 2 && s.shares[1].paid && s.shares[1].payer?.toLowerCase() === priyaAddress.toLowerCase(), s.shares[1].txHash ?? "");
    await goto(priya.page, `${APP}/activity`);
    await shot(priya.page, "17-phone-friend-activity");

    // ── 4. Maya: who paid, Activity on both screens, and closing it ─────────
    await goto(maya.page, dinnerUrl);
    await waitFor(maya.page, "2 of 4 paid");
    await shot(maya.page, "18-phone-organiser-2-of-4");
    step("Split: Maya's page: 2 of 4 paid, $80.00 of $160.00 collected", await seen(maya.page, "$80.00 of $160.00 collected"));
    step("Split: $80.00 is in Maya's account", (await balanceOf(mayaAddress)) - mayaBefore === 80_000_000n);
    await goto(maya.page, `${APP}/activity`);
    await waitFor(maya.page, "Your splits");
    await shot(maya.page, "19-phone-activity");
    // On a phone each share is a row named for its friend ("Sam · Split · paid you"); the desktop's table adds what it was for.
    step("Split: Activity lists Maya's split and each share that landed, by name", (await seen(maya.page, "Dinner at Lucia")) && (await visible(maya.page, /paid you/).count()) >= 2 && (await seen(maya.page, "Sam")) && (await seen(maya.page, "Priya")));

    await maya.page.setViewportSize(DESKTOP);
    await goto(maya.page, `${APP}/activity`);
    await waitFor(maya.page, "Your splits");
    await shot(maya.page, "20-desktop-activity");
    step("Split: on the desktop, each share reads \"Paid their share · Dinner at Lucia\"", (await visible(maya.page, "Paid their share · Dinner at Lucia").count()) >= 2);
    await maya.page.getByRole("link", { name: /Dinner at Lucia: 2 of 4 paid/ }).click();
    await waitFor(maya.page, "Collected so far");
    await shot(maya.page, "21-desktop-organiser-split");
    await maya.page.getByRole("button", { name: "Close split" }).click();
    await confirm(maya.page, { label: /Close with Face ID/, shotName: "22-desktop-close-confirm" });
    await waitFor(maya.page, "You closed this split", 90000);
    await shot(maya.page, "23-desktop-organiser-closed");
    s = await splitStatus(dinnerId);
    step("Split: closed: 2 of 4 paid, the other two cancelled, nothing moved", s.status === "closed" && s.paidCount === 2 && (await balanceOf(mayaAddress)) - mayaBefore === 80_000_000n, s.closedAt ?? "");

    // ── 5. Jon, after it closed ───────────────────────────────────────────
    const jon = await open("jon", PHONE);
    await goto(jon.page, dinnerUrl);
    await waitFor(jon.page, "Maya closed this split", 90000);
    await shot(jon.page, "24-phone-friend-closed");
    step("Split: Jon opens the closed link: nothing to pay, nothing charged", (await jon.page.getByRole("button", { name: /^Pay \$/ }).count()) === 0);

    // ── 6. Groceries by named amounts, from Maya's desktop; everyone pays ─────
    await goto(maya.page, `${APP}/split/new`);
    const form = maya.page.getByRole("dialog").last();
    await form.getByLabel("The bill").fill("90");
    await form.getByLabel("What's it for").fill("Cabin groceries");
    await form.getByRole("radio", { name: "By amount" }).click();
    await form.getByLabel("Friend 1's name").fill("Sam");
    await form.getByLabel(/What Sam owes/).fill("35.50");
    await form.getByLabel("Friend 2's name").fill("Priya");
    await form.getByLabel(/What Priya owes/).fill("24.50");
    await form.getByLabel("What's it for").click();
    await shot(maya.page, "25-desktop-new-by-amount");
    await form.getByRole("button", { name: /^Create link for \$60/ }).click();
    await confirm(maya.page, { shotName: "26-desktop-new-confirm" });
    await waitFor(maya.page, "Link ready.", 90000);
    await shot(maya.page, "27-desktop-link-ready");
    const groceries = Object.entries(await knownSplits(maya.page)).find(([id, v]) => v.role === "organiser" && id !== dinnerId);
    const [groceriesId, { url: groceriesUrl }] = groceries;
    evidence.splits.groceries = { id: groceriesId, url: groceriesUrl };
    s = await splitStatus(groceriesId);
    step("Split: by amount: Sam $35.50 and Priya $24.50, $60.00 to collect", s.shareCount === 2 && s.shares[0].amountUnits === "35500000" && s.shares[1].amountUnits === "24500000");

    await goto(sam.page, groceriesUrl);
    await pickAndPay(sam, "Sam");
    await waitFor(sam.page, "Paid.", 90000);
    await goto(priya.page, groceriesUrl);
    await waitFor(priya.page, "1 of 2 paid", 90000);
    await pickAndPay(priya, "Priya");
    await waitFor(priya.page, "Paid.", 90000);
    s = await splitStatus(groceriesId);
    step("Split: everyone paid the groceries: settled on chain", s.status === "settled" && s.paidCount === 2);
    await goto(maya.page, groceriesUrl);
    await waitFor(maya.page, "Everyone paid");
    await shot(maya.page, "28-desktop-organiser-settled");
    await maya.page.setViewportSize(PHONE);
    await goto(maya.page, groceriesUrl);
    await waitFor(maya.page, "Everyone paid");
    await shot(maya.page, "29-phone-organiser-settled");
    await goto(maya.page, `${APP}/activity`);
    await waitFor(maya.page, "Your splits");
    await shot(maya.page, "30-phone-activity-after");
    const total = (await balanceOf(mayaAddress)) - mayaBefore;
    step("Split: Maya received $140.00 in all ($80.00 dinner, $60.00 groceries), straight to her account", total === 140_000_000n, `${Number(total) / 1e6}`);

    evidence.accounts = { maya: mayaAddress, sam: samAddress, priya: priyaAddress };
    evidence.relayed = relayed.map((r) => ({ who: r.who, type: r.body.type, splitId: r.body.splitId ?? null, index: r.body.index ?? null }));
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
  return evidence;
}

module.exports = { runSplit, demoUrls };

if (require.main === module) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
  const out = process.env.OUT || path.join(REPO, "docs", "design", "split");
  const profile = process.env.PROFILE || path.join(os.tmpdir(), `polaris-split-e2e-${Date.now()}`);
  const results = [];
  const step = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  };
  runSplit({ chromium, out, profile, step })
    .then((evidence) => {
      fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ ranAt: new Date().toISOString(), results, evidence }, null, 2));
      console.log(`${results.filter((r) => r.ok).length} of ${results.length} passed`);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e);
      fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ ranAt: new Date().toISOString(), results, error: String(e?.message ?? e) }, null, 2));
      process.exit(1);
    });
}
