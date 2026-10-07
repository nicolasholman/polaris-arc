#!/usr/bin/env node
/**
 * Checks a public deployment of Polaris before anyone else opens it: the
 * four apps answer over HTTPS, each is wired to the others, no development
 * switch reached a public build, and everything points at the Monad testnet
 * deployment the SDK's presets carry. It only reads: GET and OPTIONS
 * requests, plus two it expects refused without credentials (an unsigned
 * POST to the shop's webhook, a PUT to the API's scheduler route), and the
 * repository's own deployment record and SDK presets.
 *
 *   node scripts/deploy-check.mjs \
 *     --app https://app.example.com --business https://business.example.com \
 *     --landing https://example.com --shop https://shop.example.com
 *
 * Also from the environment: POLARIS_APP_URL, POLARIS_BUSINESS_URL,
 * POLARIS_LANDING_URL, POLARIS_SHOP_URL.
 *
 * Options:
 *   --android-package <name>  require /.well-known/assetlinks.json on the app
 *                             to name this Android package (ANDROID_PACKAGE);
 *                             without it the file is checked only if served
 *   --cron-secret <secret>    Polaris for Business's CRON_SECRET, so its health
 *                             route lists what production is missing
 *                             (POLARIS_CRON_SECRET)
 *   --allow-http              accept http:// URLs (local production builds)
 *   --chain-id <id>           the chain to expect (default 10143, Monad testnet)
 *   --deployment <path>       the deployment record (default
 *                             packages/contracts/deployments/monad-testnet.json)
 *   --timeout <ms>            per request (default 15000)
 *   --json                    print the results as JSON
 *
 * Exit status: 0 when nothing failed (warnings allowed), 1 when something
 * did, 2 on bad arguments. docs/deploy.md explains each check.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MONAD_TESTNET = 10143;
const PROBE_ORIGIN = "https://deploy-check.invalid";

/* ── arguments ───────────────────────────────────────────────────────────── */

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(["app", "business", "landing", "shop", "android-package", "cron-secret", "chain-id", "deployment", "timeout"]);
const BOOLEAN_FLAGS = new Set(["allow-http", "json", "help"]);

export function parseArgs(argv, env = {}) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // what `pnpm deploy:check -- …` may pass along
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument ${JSON.stringify(arg)}.`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value.`);
      flags[name] = value;
    } else {
      throw new UsageError(`Unknown option --${name}.`);
    }
  }
  if (flags.help) return { help: true };

  const allowHttp = Boolean(flags["allow-http"]);
  const urls = {};
  for (const [key, envName] of [
    ["app", "POLARIS_APP_URL"],
    ["business", "POLARIS_BUSINESS_URL"],
    ["landing", "POLARIS_LANDING_URL"],
    ["shop", "POLARIS_SHOP_URL"],
  ]) {
    const raw = flags[key] ?? env[envName];
    if (!raw) throw new UsageError(`--${key} (or ${envName}) is required.`);
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new UsageError(`--${key} must be a URL, got ${JSON.stringify(raw)}.`);
    }
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
      throw new UsageError(`--${key} must be an https:// URL (${raw}); --allow-http accepts http:// for local builds.`);
    }
    urls[key] = url.origin;
  }

  const chainId = Number(flags["chain-id"] ?? MONAD_TESTNET);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new UsageError("--chain-id must be a positive integer.");
  const timeoutMs = Number(flags.timeout ?? 15_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError("--timeout must be a number of milliseconds.");
  const deployment = flags.deployment ?? join("packages", "contracts", "deployments", "monad-testnet.json");

  return {
    help: false,
    urls,
    allowHttp,
    androidPackage: flags["android-package"] ?? env.ANDROID_PACKAGE ?? null,
    cronSecret: flags["cron-secret"] ?? env.POLARIS_CRON_SECRET ?? null,
    chainId,
    timeoutMs,
    deployment: isAbsolute(deployment) ? deployment : join(REPO, deployment),
    json: Boolean(flags.json),
  };
}

/* ── the repository's side: the deployment record and the SDK presets ────── */

/** Contract names in the deployment record → the SDK preset's field names. */
export const SDK_FIELDS = {
  PolarisPayments: "payments",
  PolarisLoanEngine: "loanEngine",
  ScoreManager: "scoreManager",
  CollateralVault: "collateralVault",
  PolarisCheckout: "checkout",
  PolarisSend: "send",
  MerchantRegistry: "merchantRegistry",
  BatchSettlement: "batchSettlement",
};

/** The record's chain and contract addresses (the demo merchant's key, if a local record has one, is never read). */
export function loadDeployment(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const contracts = {};
  for (const [name, entry] of Object.entries(json.contracts ?? {})) {
    const address = entry && typeof entry === "object" ? entry.address : entry;
    if (typeof address === "string") contracts[name] = address;
  }
  return { path, chainId: Number(json.chainId), contracts, demoMerchant: json.demo?.merchant ?? null };
}

/**
 * The `monadTestnet` preset from packages/sdk/src/deployments.ts, which
 * scripts/gen-deployments.mjs generates in a fixed shape: read as text, so
 * the check needs no build of the SDK.
 */
export function parseSdkPreset(source, key = "monadTestnet") {
  const start = source.indexOf(`  ${key}: {`);
  if (start < 0) throw new Error(`packages/sdk/src/deployments.ts has no ${key} preset.`);
  const end = source.indexOf("\n  },", start);
  const block = source.slice(start, end < 0 ? undefined : end);
  const field = (name) => block.match(new RegExp(`\\b${name}: "(0x[0-9a-fA-F]{40})"`))?.[1] ?? null;
  const chainId = Number(block.match(/\bchainId: (\d+)/)?.[1]);
  return {
    chainId,
    stablecoin: field("stablecoin"),
    contracts: Object.fromEntries(Object.values(SDK_FIELDS).map((name) => [name, field(name)])),
  };
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/* ── HTTP ────────────────────────────────────────────────────────────────── */

/** One request, never throwing: `{ status, headers, text, json, url, error }`. */
export function makeRequester(fetchImpl, timeoutMs) {
  return async function request(url, { method = "GET", headers = {}, body, redirect = "follow" } = {}) {
    try {
      const res = await fetchImpl(url, { method, headers, body, redirect, signal: AbortSignal.timeout(timeoutMs) });
      const text = method === "OPTIONS" || method === "HEAD" ? "" : await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, json, url: res.url || url, error: null };
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.name;
      return { status: 0, headers: new Headers(), text: "", json: null, url, error: `${error?.message ?? error}${cause ? ` (${cause})` : ""}` };
    }
  };
}

/* ── results ─────────────────────────────────────────────────────────────── */

export const PASS = "pass";
export const WARN = "warn";
export const FAIL = "fail";
export const SKIP = "skip";

function recorder(results, target) {
  const add = (status) => (id, message) => results.push({ target, id, status, message });
  return { pass: add(PASS), warn: add(WARN), fail: add(FAIL), skip: add(SKIP) };
}

const described = (res) => (res.error ? res.error : `HTTP ${res.status}`);

/* ── transport: HTTPS, redirects, headers ────────────────────────────────── */

async function checkTransport(ctx, target) {
  const { request, urls, allowHttp } = ctx;
  const origin = urls[target];
  const r = recorder(ctx.results, target);
  const home = await request(`${origin}/`);
  ctx.homes[target] = home;
  if (home.status >= 200 && home.status < 300) r.pass("reachable", `${origin}/ answers ${home.status}.`);
  else r.fail("reachable", `${origin}/ answered ${described(home)}.`);

  const url = new URL(origin);
  if (url.protocol === "https:") {
    r.pass("https", `Served over HTTPS${home.status ? " with a certificate this machine trusts" : ""}.`);
    const plain = await request(`http://${url.host}/`, { redirect: "manual" });
    const location = plain.headers.get("location") ?? "";
    if (plain.status >= 300 && plain.status < 400 && location.startsWith("https://")) r.pass("http-redirect", `http:// redirects to HTTPS (${plain.status}).`);
    else r.warn("http-redirect", `http://${url.host}/ answered ${described(plain)} instead of a redirect to HTTPS.`);
    if (home.headers.get("strict-transport-security")) r.pass("hsts", "Strict-Transport-Security is set.");
    else if (home.status) r.warn("hsts", "No Strict-Transport-Security header.");
  } else {
    r.warn("https", `${origin} is plain HTTP (--allow-http): fine for a local build, never for the submission.`);
  }

  if (home.status) {
    if (home.headers.get("x-powered-by")) r.warn("headers", `X-Powered-By is set (${home.headers.get("x-powered-by")}).`);
    else if (home.headers.get("x-content-type-options") !== "nosniff") r.warn("headers", "X-Content-Type-Options: nosniff is missing.");
    else r.pass("headers", "nosniff set, no X-Powered-By.");
  }
}

/* ── the Polaris app ─────────────────────────────────────────────────────── */

/**
 * Hosting platforms' shared parent domains: public suffixes, which a
 * relying party id can never be (each project's own subdomain can).
 */
const PLATFORM_SUFFIXES = ["vercel.app", "fly.dev", "up.railway.app", "railway.app", "netlify.app", "pages.dev", "github.io", "onrender.com", "herokuapp.com"];

/** Whether a WebAuthn relying party id may be used on this host: the host itself or a registrable suffix of it. */
export function rpIdFits(rpId, host) {
  const id = rpId.toLowerCase();
  const h = host.toLowerCase();
  if (PLATFORM_SUFFIXES.includes(id)) return false;
  return h === id || (h.endsWith(`.${id}`) && id.includes("."));
}

/** assetlinks.json statements for an Android app: problems with the file's shape, and the packages it names. */
export function inspectAssetLinks(json) {
  if (!Array.isArray(json)) return { problems: ["it is not a JSON array of statements"], packages: [] };
  const problems = [];
  const packages = [];
  json.forEach((statement, i) => {
    const target = statement?.target;
    const relations = Array.isArray(statement?.relation) ? statement.relation : [];
    if (target?.namespace !== "android_app") return;
    if (typeof target.package_name !== "string" || !target.package_name) problems.push(`statement ${i} has no package_name`);
    const prints = Array.isArray(target.sha256_cert_fingerprints) ? target.sha256_cert_fingerprints : [];
    if (prints.length === 0) problems.push(`statement ${i} (${target.package_name}) has no sha256_cert_fingerprints`);
    for (const print of prints) {
      if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(print)) problems.push(`statement ${i} has a malformed fingerprint ${JSON.stringify(print)} (32 upper-case hex bytes, colon-separated)`);
    }
    if (!relations.includes("delegate_permission/common.handle_all_urls") && !relations.includes("delegate_permission/common.get_login_creds")) {
      problems.push(`statement ${i} (${target.package_name}) grants neither handle_all_urls nor get_login_creds`);
    }
    packages.push({ name: target.package_name, relations });
  });
  if (packages.length === 0 && problems.length === 0) problems.push("it names no android_app target");
  return { problems, packages };
}

async function checkApp(ctx) {
  const { request, urls, deployment } = ctx;
  const origin = urls.app;
  const host = new URL(origin).hostname;
  const r = recorder(ctx.results, "app");

  const home = ctx.homes.app;
  if (home?.status) {
    const xfo = home.headers.get("x-frame-options") ?? "";
    const csp = home.headers.get("content-security-policy") ?? "";
    if (/deny/i.test(xfo) || /frame-ancestors\s+'none'/i.test(csp)) r.pass("framing", "The app refuses to be framed (Face ID and checkout never run inside another site).");
    else r.fail("framing", "Neither X-Frame-Options: DENY nor frame-ancestors 'none': is this the Polaris app's own next.config.ts?");
  }

  const res = await request(`${origin}/api/health`);
  const info = res.json;
  if (res.status !== 200 || info?.service !== "polaris-app") {
    r.fail("health", `${origin}/api/health answered ${described(res)}${res.status === 200 ? " without service: polaris-app" : ""}: an older build, or not the Polaris app.`);
  } else {
    r.pass("health", `/api/health answers (chain ${info.chainId}, ${info.target} build).`);
    if (info.production) r.pass("production-build", "A production build.");
    else r.fail("production-build", "Not a production build (next dev?).");
    const devSwitches = ["devSigner", "devSignerPersist", "localDemo", "localFaucet"].filter((k) => info[k]);
    if (devSwitches.length === 0) r.pass("dev-signer", "No dev signer, no local demo switches: accounts are Face ID (and email, when Privy is set).");
    else r.fail("dev-signer", `Built with ${devSwitches.join(", ")} on. Unset NEXT_PUBLIC_DEV_SIGNER, NEXT_PUBLIC_DEV_SIGNER_PERSIST, NEXT_PUBLIC_LOCAL_DEMO and NEXT_PUBLIC_LOCAL_FAUCET_URL and rebuild.`);

    if (!info.apiUrl) r.fail("api-url", "NEXT_PUBLIC_POLARIS_API_URL is unset: the app only says Polaris isn't configured on this build and signs nothing. Set it to Polaris for Business and rebuild.");
    else if (same(new URL(info.apiUrl).origin, urls.business)) r.pass("api-url", `Talks to Polaris for Business at ${urls.business}.`);
    else r.fail("api-url", `NEXT_PUBLIC_POLARIS_API_URL is ${info.apiUrl}, not ${urls.business}.`);

    if (info.chainId === ctx.chainId) r.pass("chain", `Chain ${info.chainId}.`);
    else r.fail("chain", `Built for chain ${info.chainId}, expected ${ctx.chainId} (NEXT_PUBLIC_CHAIN_ID).`);

    if (!info.rpId) {
      r.warn("rp-id", `NEXT_PUBLIC_RP_ID is unset, so Face ID accounts belong to ${host}. Moving to another domain later strands them: set it now if the app will live on a domain of your own.`);
    } else if (rpIdFits(info.rpId, host)) {
      r.pass("rp-id", `Face ID accounts belong to ${info.rpId}, which ${host} may use.`);
    } else {
      r.fail("rp-id", `NEXT_PUBLIC_RP_ID is ${info.rpId}, which ${host} can't use: passkeys fail. It must be ${host} or a domain ${host} is under.`);
    }

    if (info.privyAppId) r.pass("privy", "Continue with email is on (Privy).");
    else r.warn("privy", "NEXT_PUBLIC_PRIVY_APP_ID is unset: only Face ID is offered.");
    ctx.appInfo = info;

    for (const [name, address] of Object.entries(info.pinnedContracts ?? {})) {
      const recordName = { ausd: "Stablecoin", payments: "PolarisPayments", checkout: "PolarisCheckout", send: "PolarisSend", loanEngine: "PolarisLoanEngine" }[name];
      const expected = deployment?.contracts[recordName];
      if (!expected) r.warn("pinned-contracts", `NEXT_PUBLIC_*_ADDRESS pins ${name} ${address}, which the deployment record doesn't name.`);
      else if (same(address, expected)) r.pass("pinned-contracts", `${name} pinned to the deployment's ${address}.`);
      else r.fail("pinned-contracts", `${name} is pinned to ${address}, the deployment has ${expected}: the app will refuse to sign.`);
    }
  }

  const manifest = await request(`${origin}/manifest.webmanifest`);
  if (manifest.status === 200 && manifest.json?.name) r.pass("manifest", `The web app manifest is served (${manifest.json.name}).`);
  else r.warn("manifest", `/manifest.webmanifest answered ${described(manifest)}: the app can't be installed.`);

  const links = await request(`${origin}/.well-known/assetlinks.json`, { redirect: "manual" });
  if (links.status === 200) {
    const { problems, packages } = inspectAssetLinks(links.json);
    const type = links.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) problems.push(`it is served as ${type || "no content type"}, not application/json`);
    const named = packages.map((p) => p.name);
    if (ctx.androidPackage && !named.includes(ctx.androidPackage)) problems.push(`it doesn't name ${ctx.androidPackage} (it names ${named.join(", ") || "nothing"})`);
    if (problems.length) r.fail("assetlinks", `/.well-known/assetlinks.json: ${problems.join("; ")}.`);
    else r.pass("assetlinks", `/.well-known/assetlinks.json names ${named.join(", ")}.`);
  } else if (links.status >= 300 && links.status < 400) {
    r.fail("assetlinks", "/.well-known/assetlinks.json redirects; Android refuses to follow a redirect for it.");
  } else if (ctx.androidPackage) {
    r.fail("assetlinks", `/.well-known/assetlinks.json answered ${described(links)}, and --android-package ${ctx.androidPackage} needs it.`);
  } else {
    r.skip("assetlinks", "No /.well-known/assetlinks.json (no Android app configured).");
  }
}

/* ── Polaris for Business ────────────────────────────────────────────────── */

/** The deployment record's contract names → the health route's `chain.contracts` fields. */
const HEALTH_CONTRACTS = {
  Stablecoin: "stablecoin",
  PolarisCheckout: "checkout",
  PolarisPayments: "payments",
  PolarisSend: "send",
  PolarisLoanEngine: "loanEngine",
  MerchantRegistry: "registry",
  ScoreManager: "scoreManager",
  CollectionsReceiver: "collections",
  UnderwritingReceiver: "underwriting",
  GuardianReceiver: "guardian",
};

async function preflight(ctx, path, origin, method = "POST") {
  return ctx.request(`${ctx.urls.business}${path}`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": "content-type" },
  });
}

async function checkBusiness(ctx) {
  const { request, urls, deployment } = ctx;
  const origin = urls.business;
  const r = recorder(ctx.results, "business");

  const headers = ctx.cronSecret ? { authorization: `Bearer ${ctx.cronSecret}` } : {};
  const res = await request(`${origin}/api/health`, { headers });
  const health = res.json?.data;
  if (res.status !== 200 || !health || !("checkoutOrigin" in health)) {
    r.fail("health", `${origin}/api/health answered ${described(res)}: not Polaris for Business, or it didn't start.`);
  } else {
    ctx.businessHealth = health;
    r.pass("health", `/api/health answers (${health.chain ? `${health.chain.name}, ${health.chain.id}` : "no chain"}).`);

    if (!health.chain) r.fail("chain", `No chain: ${health.chainProblem ?? "the deployment record wasn't found"}.`);
    else if (health.chain.id !== ctx.chainId) r.fail("chain", `On chain ${health.chain.id}, expected ${ctx.chainId} (POLARIS_DEPLOYMENT).`);
    else {
      const wrong = Object.entries(HEALTH_CONTRACTS)
        .filter(([name, field]) => deployment?.contracts[name] && !same(health.chain.contracts[field], deployment.contracts[name]))
        .map(([name, field]) => `${name} is ${health.chain.contracts[field] ?? "missing"}, the record has ${deployment.contracts[name]}`);
      if (wrong.length) r.fail("contracts", `The server's contracts aren't the deployment's: ${wrong.join("; ")}.`);
      else r.pass("contracts", `Serves the ${ctx.chainId} deployment (${Object.keys(HEALTH_CONTRACTS).length} contracts match ${relativeToRepo(deployment.path)}).`);
    }

    const relayer = health.relayer ?? {};
    if (relayer.mode === "privy") r.pass("relayer", `The Privy server wallet relays (${relayer.address}).`);
    else if (relayer.mode === "local") r.warn("relayer", `The dev relayer relays (a raw key, ${relayer.address ?? "no address"}): the README's testnet setup, not the Privy server wallet.`);
    else r.fail("relayer", "RELAYER_MODE is off: nothing is relayed, so no one can pay.");

    if (same(health.checkoutOrigin, urls.app)) r.pass("checkout-origin", `POLARIS_CHECKOUT_ORIGIN is the app (${urls.app}).`);
    else r.fail("checkout-origin", `POLARIS_CHECKOUT_ORIGIN is ${health.checkoutOrigin ?? "unset"}, expected ${urls.app}: payment links would send buyers elsewhere.`);

    if (same(health.publicUrl, origin)) r.pass("public-url", `POLARIS_PUBLIC_URL is ${origin}.`);
    else r.fail("public-url", `POLARIS_PUBLIC_URL is ${health.publicUrl ?? "unset"}, expected ${origin}: merchants' registrations would name the wrong server.`);

    // The dev relayer is always one of production's problems ("The relayer signs with a raw key."); the
    // relayer check above already warns about it, so on its own it doesn't fail the deployment.
    const devRelayer = relayer.mode === "local";
    const problems = (health.problems ?? []).filter((p) => !(devRelayer && /relayer signs with a raw key/i.test(p)));
    if (health.productionReady) r.pass("production-ready", "Nothing production needs is missing.");
    else if (health.problems && problems.length === 0) r.pass("production-ready", "Nothing production needs is missing, apart from the dev relayer (above).");
    else if (health.problems) r.fail("production-ready", `Production is missing: ${problems.join(" ")}`);
    else if (devRelayer) r.warn("production-ready", "Production reports something missing. The dev relayer is always on that list; pass --cron-secret to see whether anything else is.");
    else r.fail("production-ready", "Production is missing something; pass --cron-secret to see what (or read the server's startup log).");

    const build = health.build;
    if (!build) {
      r.fail("dev-session", "/api/health has no build flags: an older build.");
    } else {
      if (build.production) r.pass("production-build", "A production build (NODE_ENV=production).");
      else r.fail("production-build", "Not a production build.");
      if (!build.devMockSession && !build.localSession) r.pass("dev-session", "No mock or local dashboard session.");
      else r.fail("dev-session", `${build.devMockSession ? "POLARIS_DEV_MOCK_SESSION" : "POLARIS_LOCAL_SESSION_*"} is on: unset it and rebuild.`);
      if (!build.privy) r.fail("privy", "Privy isn't configured on the server (PRIVY_APP_ID and PRIVY_APP_SECRET): merchants can't sign in.");
      else if (!build.privyAppId) r.fail("privy", "The dashboard was built without NEXT_PUBLIC_PRIVY_APP_ID (a build argument): the sign-in page can't load Privy.");
      else if (build.privyServerAppId && build.privyServerAppId !== build.privyAppId) r.fail("privy", "The browser bundle and the server use different Privy apps: every sign-in would fail verification.");
      else r.pass("privy", "Privy is configured, the same app in the browser and on the server.");
      if (ctx.appInfo?.privyAppId && build.privyAppId && ctx.appInfo.privyAppId !== build.privyAppId) {
        r.warn("privy", "The app's NEXT_PUBLIC_PRIVY_APP_ID isn't the dashboard's: they should be one Privy app.");
      }
      if (!build.demoShopUrl) r.warn("demo-shop", "NEXT_PUBLIC_DEMO_SHOP_URL is unset: \"See the demo shop\" is disabled.");
      else if (same(new URL(build.demoShopUrl).origin, urls.shop)) r.pass("demo-shop", `"See the demo shop" opens ${urls.shop}.`);
      else r.warn("demo-shop", `"See the demo shop" opens ${build.demoShopUrl}, not ${urls.shop}.`);
    }
  }

  const readyRes = await request(`${origin}/api/health/ready`);
  const ready = readyRes.json?.data;
  if (!ready || !("checks" in ready)) {
    r.fail("ready", `${origin}/api/health/ready answered ${described(readyRes)}.`);
  } else {
    const failing = Object.entries(ready.checks).filter(([, c]) => !c.ok);
    if (ready.ready) r.pass("ready", "Ready: configuration, chain, store and background loops.");
    else r.fail("ready", `Not ready: ${failing.map(([name, c]) => `${name}: ${c.detail}`).join(" ")}`);
    const store = ready.checks.store;
    if (store.persistent) r.pass("store", `${store.detail} (keep it on a volume).`);
    else r.fail("store", `The store is ${store.kind}: every restart loses merchants, keys and payments. Set POLARIS_DB_URL=sqlite:/data/polaris.db on a volume.`);
    const workers = ready.checks.workers;
    if (!workers.enabled) r.warn("workers", "POLARIS_WORKERS is off: webhooks, payouts and the chain sync run only if a scheduler calls POST /api/cron/tick.");
    else if (workers.running) r.pass("workers", "The background loops run in the server.");
    const age = ready.sync?.ageSeconds;
    if (!workers.enabled) r.skip("chain-sync", "The chain sync runs from the scheduler.");
    else if (age === null || age === undefined) r.warn("chain-sync", "The chain sync hasn't recorded a block yet (just started, or it can't reach POLARIS_RPC_URL).");
    else if (age <= 120) r.pass("chain-sync", `The chain sync read block ${ready.sync.block} ${age} s ago.`);
    else r.warn("chain-sync", `The chain sync last moved ${age} s ago (block ${ready.sync.block}): is POLARIS_RPC_URL answering?`);
  }

  const network = await request(`${origin}/api/public/network`, { headers: { origin: urls.app } });
  if (network.status === 200 && network.json?.data?.contracts) {
    ctx.network = network.json.data;
    r.pass("network", `/api/public/network serves chain ${ctx.network.chainId}${ctx.network.relayer?.available ? ", relayer available" : ", relayer unavailable"}.`);
  } else {
    r.fail("network", `/api/public/network answered ${described(network)}: the app can't build a single signature.`);
  }

  // CORS: the app may call the API from the browser, a stranger may not; any page may pay with a publishable key.
  const allowed = await preflight(ctx, "/api/public/network", urls.app, "GET");
  const allowedRelay = await preflight(ctx, "/api/relay", urls.app);
  const stranger = await preflight(ctx, "/api/relay", PROBE_ORIGIN);
  const shopPay = await preflight(ctx, "/api/v1/relay/payments", urls.shop);
  const acao = (res) => res.headers.get("access-control-allow-origin");
  if (same(acao(allowed), urls.app) && same(acao(allowedRelay), urls.app)) r.pass("cors", `The app's origin may call /api/public and /api/relay.`);
  else r.fail("cors", `A preflight from ${urls.app} was refused (${described(allowedRelay)}, Access-Control-Allow-Origin ${acao(allowedRelay) ?? "absent"}): set POLARIS_CHECKOUT_ORIGIN (or POLARIS_APP_ORIGINS) to it.`);
  if (acao(stranger) && (acao(stranger) === "*" || same(acao(stranger), PROBE_ORIGIN))) r.fail("cors-strangers", "/api/relay accepts preflights from any origin.");
  else r.pass("cors-strangers", "Other origins can't call /api/relay from a browser.");
  if (acao(shopPay) === "*" || same(acao(shopPay), urls.shop)) r.pass("cors-shop", "The shop's pages may pay through /api/v1/relay/payments with its publishable key.");
  else r.fail("cors-shop", `A preflight from ${urls.shop} to /api/v1/relay/payments answered ${described(shopPay)}.`);

  // Nothing signs in, or runs a scheduled job, without its credential.
  const me = await request(`${origin}/api/me`);
  if (me.status === 401) r.pass("dashboard-auth", "/api/me refuses a request without a session.");
  else if (me.status === 503) r.warn("dashboard-auth", "/api/me answers 503: Privy isn't configured on the server.");
  else r.fail("dashboard-auth", `/api/me without a session answered ${described(me)}.`);
  // PUT: refused by the credential check first, and never runs a tick even where the check is broken.
  const tick = await request(`${origin}/api/cron/tick`, { method: "PUT" });
  if (tick.status === 401 || tick.status === 503) r.pass("cron-auth", `/api/cron/tick refuses a request without CRON_SECRET (${tick.status}).`);
  else r.fail("cron-auth", `/api/cron/tick without CRON_SECRET answered ${described(tick)}.`);
}

/* ── Halcyon, the demo shop ──────────────────────────────────────────────── */

async function checkShop(ctx) {
  const { request, urls } = ctx;
  const origin = urls.shop;
  const r = recorder(ctx.results, "shop");

  const res = await request(`${origin}/api/health`);
  const health = res.json;
  if (res.status !== 200 || health?.service !== "halcyon-shop") {
    r.fail("health", `${origin}/api/health answered ${described(res)}: an older build, or not Halcyon.`);
  } else {
    r.pass("health", "/api/health answers.");
    if (health.production) r.pass("production", "A production build.");
    else r.fail("production", "Not a production build: deploy with next build and next start.");

    const polaris = health.polaris;
    if (!polaris?.configured) {
      r.fail("polaris", `Payments aren't configured: ${polaris?.reason ?? "no Polaris configuration"}`);
    } else {
      if (same(polaris.apiBase, urls.business)) r.pass("polaris", `Pays through Polaris for Business at ${urls.business} (${polaris.publishableKeyMode} keys).`);
      else r.fail("polaris", `POLARIS_API_BASE is ${polaris.apiBase}, expected ${urls.business}.`);
      if (same(polaris.checkoutOrigin, urls.app)) r.pass("checkout-origin", `Opens the checkout at ${urls.app}.`);
      else r.fail("checkout-origin", `NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN is ${polaris.checkoutOrigin}, expected ${urls.app}: the popup's results would be ignored.`);
      if (polaris.relayUrl?.startsWith(`${urls.business}/`)) r.pass("relay-url", "Direct wallet payments relay through Polaris for Business.");
      else r.warn("relay-url", `Direct wallet payments relay through ${polaris.relayUrl}.`);
      if (ctx.deployment?.demoMerchant && same(polaris.merchant, ctx.deployment.demoMerchant)) {
        r.pass("merchant", `Pays the deployment's demo merchant ${polaris.merchant}.`);
      } else {
        r.skip("merchant", `Pays ${polaris.merchant} (registered from the dashboard, not the deployment's demo merchant).`);
      }
    }
    if (same(health.shopUrl, origin)) r.pass("shop-url", `SHOP_URL is ${origin}.`);
    else r.fail("shop-url", `SHOP_URL is ${health.shopUrl ?? "unset"}, expected ${origin}: success and cancel URLs would point elsewhere.`);

    const store = health.orderStore ?? {};
    if (store.kind === "redis") r.pass("order-store", "Orders are kept in Redis, shared by every function.");
    else if (store.serverless) r.fail("order-store", `Orders are kept in each function's ${store.kind === "memory" ? "memory" : "memory (the disk is read-only)"}: a webhook can land where the order isn't. Connect Upstash Redis (KV_REST_API_URL, KV_REST_API_TOKEN).`);
    else if (store.kind === "memory") r.warn("order-store", "Orders are kept in memory: a restart loses them.");
    else r.pass("order-store", "Orders are kept on this server's disk (a long-lived host).");
  }

  const hook = await request(`${origin}/api/webhooks/polaris`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (hook.status === 400 || hook.status === 401) r.pass("webhook", `The webhook endpoint refuses an unsigned event (${hook.status}).`);
  else if (hook.status === 503) r.fail("webhook", "The webhook endpoint answers 503: the shop's Polaris settings are incomplete (see polaris above).");
  else r.fail("webhook", `An unsigned POST to /api/webhooks/polaris answered ${described(hook)}.`);
}

/* ── the landing page ────────────────────────────────────────────────────── */

async function checkLanding(ctx) {
  const r = recorder(ctx.results, "landing");
  const home = ctx.homes.landing;
  if (!home?.status) return;
  if (/Polaris/.test(home.text)) r.pass("content", "The landing page renders.");
  else r.fail("content", "The page doesn't mention Polaris: is this the landing app?");
  const links = [
    ["app", ctx.urls.app, "NEXT_PUBLIC_APP_URL"],
    ["business", ctx.urls.business, "NEXT_PUBLIC_BUSINESS_URL"],
  ];
  for (const [name, url, variable] of links) {
    if (home.text.includes(url)) r.pass(`links-${name}`, `Links to ${url}.`);
    else r.warn(`links-${name}`, `No link to ${url}: set ${variable} on the landing project and rebuild.`);
  }
}

/* ── the SDK's presets ───────────────────────────────────────────────────── */

function relativeToRepo(path) {
  return path.startsWith(REPO) ? path.slice(REPO.length + 1).replaceAll("\\", "/") : path;
}

function checkSdk(ctx) {
  const r = recorder(ctx.results, "sdk");
  const { deployment } = ctx;
  if (!deployment) return;
  let preset;
  try {
    preset = parseSdkPreset(readFileSync(join(REPO, "packages", "sdk", "src", "deployments.ts"), "utf8"));
  } catch (error) {
    r.fail("presets", error.message);
    return;
  }
  if (deployment.chainId !== ctx.chainId) r.fail("record", `${relativeToRepo(deployment.path)} is chain ${deployment.chainId}, expected ${ctx.chainId}.`);
  const wrong = [];
  if (preset.chainId !== deployment.chainId) wrong.push(`chainId ${preset.chainId}`);
  if (!same(preset.stablecoin, deployment.contracts.Stablecoin)) wrong.push(`stablecoin ${preset.stablecoin}`);
  for (const [name, field] of Object.entries(SDK_FIELDS)) {
    if (deployment.contracts[name] && !same(preset.contracts[field], deployment.contracts[name])) wrong.push(`${field} ${preset.contracts[field]}`);
  }
  if (wrong.length) r.fail("presets", `polarispay-sdk's MONAD_TESTNET preset isn't ${relativeToRepo(deployment.path)}: ${wrong.join(", ")} (pnpm --filter polarispay-sdk gen:deployments).`);
  else r.pass("presets", `polarispay-sdk's MONAD_TESTNET preset is the deployment in ${relativeToRepo(deployment.path)}.`);

  const network = ctx.network;
  if (!network) {
    r.skip("presets-live", "Polaris for Business's /api/public/network didn't answer; the live comparison is skipped.");
    return;
  }
  const live = [
    ["stablecoin", network.contracts.stablecoin, preset.stablecoin],
    ["payments", network.contracts.payments, preset.contracts.payments],
    ["checkout", network.contracts.checkout, preset.contracts.checkout],
    ["send", network.contracts.send, preset.contracts.send],
    ["loanEngine", network.contracts.loanEngine, preset.contracts.loanEngine],
    ["merchantRegistry", network.contracts.registry, preset.contracts.merchantRegistry],
  ].filter(([, served, sdk]) => !same(served, sdk));
  if (network.chainId !== preset.chainId) live.unshift(["chainId", network.chainId, preset.chainId]);
  if (live.length) r.fail("presets-live", `The API serves other contracts than the SDK presets: ${live.map(([f, served, sdk]) => `${f} ${served} (SDK ${sdk})`).join(", ")}.`);
  else r.pass("presets-live", "The API serves the contracts the SDK presets name: a shop on polarispay-sdk and the hosted checkout sign for the same ones.");
}

/* ── running it ──────────────────────────────────────────────────────────── */

export async function runDeployCheck(options, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const ctx = {
    ...options,
    request: makeRequester(fetchImpl, options.timeoutMs),
    results: [],
    homes: {},
    deployment: null,
    appInfo: null,
    businessHealth: null,
    network: null,
  };
  try {
    ctx.deployment = loadDeployment(options.deployment);
  } catch (error) {
    ctx.results.push({ target: "sdk", id: "record", status: FAIL, message: `Can't read the deployment record ${options.deployment}: ${error.message}` });
  }
  await Promise.all(["app", "business", "landing", "shop"].map((target) => checkTransport(ctx, target)));
  await checkApp(ctx);
  await checkBusiness(ctx);
  await checkShop(ctx);
  await checkLanding(ctx);
  checkSdk(ctx);
  return ctx.results;
}

const LABEL = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
const TITLES = { app: "The Polaris app", business: "Polaris for Business", shop: "Halcyon, the demo shop", landing: "The landing page", sdk: "polarispay-sdk presets" };

export function formatReport(results, urls) {
  const lines = [];
  for (const target of ["app", "business", "shop", "landing", "sdk"]) {
    const rows = results.filter((r) => r.target === target);
    if (rows.length === 0) continue;
    lines.push("", `${TITLES[target]}${urls[target] ? `  ${urls[target]}` : ""}`);
    for (const row of rows) lines.push(`  ${LABEL[row.status]}  ${row.id.padEnd(17)} ${row.message}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  lines.push("", `${count(PASS)} passed, ${count(WARN)} warnings, ${count(FAIL)} failed, ${count(SKIP)} skipped.`);
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\nUsage: node scripts/deploy-check.mjs --app <url> --business <url> --landing <url> --shop <url> [--android-package <name>] [--cron-secret <secret>] [--allow-http] [--json]`);
    process.exit(2);
  }
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
    return;
  }
  const results = await runDeployCheck(options);
  if (options.json) console.log(JSON.stringify({ urls: options.urls, results }, null, 2));
  else console.log(formatReport(results, options.urls));
  process.exitCode = results.some((r) => r.status === FAIL) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
