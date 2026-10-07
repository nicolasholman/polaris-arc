#!/usr/bin/env node
/**
 * `pnpm demo:local`: the whole of Polaris on this machine, on a local chain.
 *
 *   1. a Hardhat node (chain 31337) and every contract, deployed with the Arc
 *      deploy script in local mode (NETWORK=local: MockUSDC and MockEURC stand
 *      in for Circle's USDC and EURC, with the same EIP-712 domains and no
 *      ERC-5267, exactly as on Arc); the credit pool funded with $50,000;
 *   2. Polaris for Business on :3100 with the dev relayer (a local key held to
 *      the production relayer policy), a fresh SQLite store, Halcyon's
 *      merchant seeded with test API keys and a webhook to the shop, registered
 *      on MerchantRegistry through the dashboard's own registration API, and
 *      a local dashboard session (no Privy);
 *   3. the Polaris keeper (services/keeper): collections every minute and on
 *      every Reauthorized, and credit reviews on :2000;
 *   4. the Polaris app on :3000 (the dev signer stands in for Face ID, so
 *      headless runs need no authenticator), Halcyon the demo shop on :3600,
 *      and a faucet on :3650 ($500 of MockUSDC and EUR 200 of MockEURC per
 *      request) that the app's Add money offers on this chain.
 *
 * DEMO_FAST_PLANS=1 deploys with minute-long instalment intervals and a
 * 15-minute grace, so the keeper collects on camera.
 *
 * Ports: DEMO_NODE_PORT (8545), DEMO_BUSINESS_PORT (3100), DEMO_APP_PORT
 * (3000), DEMO_SHOP_PORT (3600), DEMO_KEEPER_PORT (2000), DEMO_FAUCET_PORT
 * (3650). State lives in .demo/ (git-ignored), fresh on every run;
 * .demo/demo.json has every URL. Ctrl+C stops everything.
 *
 * Arc testnet instead of a local node: deploy with
 * `pnpm --filter @polarispay/contracts deploy:testnet` and run the apps
 * against deployments/arc-testnet.json (README, "Run it on Arc testnet").
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CONTRACTS = join(REPO, "packages", "contracts");
const BUSINESS = join(REPO, "apps", "business");
const APP = join(REPO, "apps", "app");
const SHOP = join(REPO, "apps", "shop");
const KEEPER = join(REPO, "services", "keeper");
const DEMO = join(REPO, ".demo");

const port = (name, fallback) => Number(process.env[name] || fallback);
const PORTS = {
  node: port("DEMO_NODE_PORT", 8545),
  business: port("DEMO_BUSINESS_PORT", 3100),
  app: port("DEMO_APP_PORT", 3000),
  shop: port("DEMO_SHOP_PORT", 3600),
  keeper: port("DEMO_KEEPER_PORT", 2000),
  faucet: port("DEMO_FAUCET_PORT", 3650),
};
const FAST_PLANS = process.env.DEMO_FAST_PLANS === "1";
/** How long each server may take to answer its first page: a cold `next dev` compile takes minutes on a slow disk. */
const STARTUP_MS = Number(process.env.DEMO_STARTUP_TIMEOUT_MS || 900_000);
const RPC = `http://127.0.0.1:${PORTS.node}`;
const BUSINESS_URL = `http://localhost:${PORTS.business}`;
const APP_URL = `http://localhost:${PORTS.app}`;
const SHOP_URL = `http://127.0.0.1:${PORTS.shop}`;
const FAUCET_URL = `http://127.0.0.1:${PORTS.faucet}`;

// Hardhat's well-known test accounts (public; valid only on a local node):
// 0 deploys, owns and mints the mock tokens; 1 relays; 2 is the keeper.
const TEST_ACCOUNTS = [
  { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
];
const OWNER = TEST_ACCOUNTS[0];
const RELAYER = TEST_ACCOUNTS[1];
const KEEPER_ACCOUNT = TEST_ACCOUNTS[2];
const USD_GIFT = 500_000_000n; // $500.00 per Add money request
const EUR_GIFT = 200_000_000n; // EUR 200.00

const children = [];
let stopping = false;


function log(msg) {
  console.log(`[demo] ${msg}`);
}

function need(path, what) {
  if (!existsSync(path)) throw new Error(`${what} is missing (${path}). Run \`pnpm install\` at the repo root first.`);
  return path;
}

async function portFree(p) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Run to completion; `pnpm` goes through the shell on Windows (it is a .cmd there). */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: cmd === "pnpm" && process.platform === "win32", ...opts });
  if (r.status !== 0) throw new Error(`${[cmd, ...args].join(" ")} exited ${r.status}`);
}

const fileUrl = (path) => new URL(`file:///${path.replace(/\\/g, "/").replace(/^\/+/, "")}`).href;

/** A long-running child whose output goes to .demo/logs/<name>.log. */
function background(name, cmd, args, opts = {}) {
  const logFile = join(DEMO, "logs", `${name}.log`);
  const out = createWriteStream(logFile);
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opts });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on("exit", (code) => {
    if (!stopping) log(`${name} exited (${code}); its log is ${logFile}`);
  });
  children.push({ name, child });
  return child;
}

async function until(what, check, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what} (see .demo/logs)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Open every page and API route once so `next dev` compiles it now, not on
 * the first click (a first POST to a route took 30 s; the landing 50 s).
 * Any answer counts, a 404 or a 401 included: the route is compiled.
 */
async function warm(base, routes) {
  const started = Date.now();
  let failed = 0;
  for (const route of routes) {
    const [method, path, body] = typeof route === "string" ? ["GET", route, undefined] : route;
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      });
      await res.arrayBuffer();
    } catch {
      failed++;
    }
  }
  return { ms: Date.now() - started, failed };
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const { child } of children.reverse()) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  log("stopping…");
  stop();
  process.exit(0);
});
process.on("exit", (code) => {
  if (code !== 0) log(`exiting (${code}); stopping everything it started`);
  stop();
});

/* ── The faucet: test dollars and euros on the local chain only ────────── */

async function startFaucet(tokens, mint) {
  const allowed = new Set([APP_URL, `http://127.0.0.1:${PORTS.app}`]);
  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? "";
    const cors = allowed.has(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", vary: "origin" } : {};
    if (req.method === "OPTIONS") return res.writeHead(204, { ...cors, "access-control-allow-methods": "POST" }).end();
    if (req.method !== "POST" || req.url !== "/mint") return res.writeHead(404, cors).end();
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { address } = JSON.parse(raw);
        if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error("address must be a 0x address");
        const txHash = await mint(address);
        log(`faucet: $500.00 of MockUSDC and EUR 200.00 of MockEURC to ${address}`);
        res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ data: { amount: "500.00", txHash, stablecoin: tokens.usdc } }));
      } catch (error) {
        res.writeHead(400, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: { code: "invalid_request", message: error.message } }));
      }
    });
  });
  await new Promise((r) => server.listen(PORTS.faucet, "127.0.0.1", r));
  return server;
}

/* ── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  for (const [name, p] of Object.entries(PORTS)) {
    if (!(await portFree(p))) throw new Error(`Port ${p} (${name}) is in use. Stop what's there, or set DEMO_${name.toUpperCase()}_PORT.`);
  }
  rmSync(DEMO, { recursive: true, force: true });
  mkdirSync(join(DEMO, "logs"), { recursive: true });

  const hardhat = need(join(CONTRACTS, "node_modules", "hardhat", "internal", "cli", "bootstrap.js"), "Hardhat");
  const nextBin = (dir) => need(join(dir, "node_modules", "next", "dist", "bin", "next"), `Next in ${dir}`);

  log("building the SDK and the underwriting package…");
  run("pnpm", ["--filter", "polarispay-sdk", "build"], { cwd: REPO, stdio: "ignore" });
  run(process.execPath, [join(BUSINESS, "scripts", "ensure-deps.mjs")], { cwd: BUSINESS });

  log(`starting a Hardhat node on ${RPC}…`);
  background("hardhat", process.execPath, [hardhat, "node", "--hostname", "127.0.0.1", "--port", String(PORTS.node)], {
    cwd: CONTRACTS,
    // A block a second, so the chain's clock moves as Arc's does and instalments fall due.
    env: { ...process.env, POLARIS_INTERVAL_MINING_MS: process.env.POLARIS_INTERVAL_MINING_MS || "1000" },
  });
  await until("the Hardhat node", async () => (await rpc("eth_chainId")) === "0x7a69", 120_000);
  log("compiling and deploying the contracts (packages/contracts scripts/deploy.js, NETWORK=local)…");
  run(process.execPath, [hardhat, "compile", "--quiet"], { cwd: CONTRACTS, stdio: "ignore" });
  const deployLog = openSync(join(DEMO, "logs", "deploy.log"), "w");
  run(process.execPath, [hardhat, "run", "scripts/deploy.js", "--network", "arcLocal"], {
    cwd: CONTRACTS,
    stdio: ["ignore", deployLog, deployLog],
    env: {
      ...process.env,
      NETWORK: "local",
      POLARIS_LOCAL_NODE_PORT: String(PORTS.node),
      POLARIS_RELAYER_ADDRESS: RELAYER.address,
      POLARIS_KEEPER_ADDRESS: KEEPER_ACCOUNT.address,
      DEPLOYER_PRIVATE_KEY: "",
      ...(FAST_PLANS ? { POLARIS_FAST_PLANS: "1" } : {}),
    },
  });
  const deploymentFile = join(DEMO, "deployment.json");
  copyFileSync(join(CONTRACTS, "deployments", "arc-local.json"), deploymentFile);
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));
  const at = (name) => deployment.contracts[name].address;
  log(`deployed on chain ${deployment.chainId}: PolarisCheckout ${at("PolarisCheckout")}, USDC ${at("USDC")}, EURC ${at("EURC")}`);

  const requireBusiness = createRequire(join(BUSINESS, "package.json"));
  const viem = await import(fileUrl(requireBusiness.resolve("viem")));
  const accounts = await import(fileUrl(requireBusiness.resolve("viem/accounts")));
  const { mockUSDCAbi } = await import(fileUrl(join(CONTRACTS, "abi", "index.mjs")));
  const chain = viem.defineChain({ id: deployment.chainId, name: "Local Hardhat", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const owner = viem.createWalletClient({ account: accounts.privateKeyToAccount(OWNER.key), chain, transport: viem.http(RPC) });
  const reader = viem.createPublicClient({ chain, transport: viem.http(RPC) });
  const mint = async (address) => {
    const hash = await owner.writeContract({ address: at("USDC"), abi: mockUSDCAbi, functionName: "mint", args: [address, USD_GIFT] });
    await reader.waitForTransactionReceipt({ hash });
    const eur = await owner.writeContract({ address: at("EURC"), abi: mockUSDCAbi, functionName: "mint", args: [address, EUR_GIFT] });
    await reader.waitForTransactionReceipt({ hash: eur });
    return hash;
  };

  const secrets = {
    pepper: randomBytes(16).toString("hex"),
    session: randomBytes(24).toString("base64url"),
    callback: randomBytes(24).toString("hex"),
    cron: randomBytes(16).toString("hex"),
  };
  const dbUrl = `sqlite:${join(DEMO, "polaris.db")}`;
  const { seedMerchant } = await import(fileUrl(join(BUSINESS, "scripts", "lib", "seed.mjs")));
  const merchantKey = accounts.generatePrivateKey();
  const merchant = accounts.privateKeyToAccount(merchantKey);
  const MERCHANT_NAME = "Halcyon";
  const seeded = await seedMerchant({ dbUrl, pepper: secrets.pepper, wallet: merchant.address, name: MERCHANT_NAME, webhookUrl: `${SHOP_URL}/api/webhooks/polaris`, registration: "none" });
  log(`seeded ${MERCHANT_NAME} (${seeded.merchant.publicId}, payout wallet ${merchant.address}) with test API keys and a webhook to the shop`);

  async function registerMerchant(account) {
    const auth = { authorization: `Bearer ${secrets.session}`, "content-type": "application/json", origin: BUSINESS_URL };
    const get = await fetch(`${BUSINESS_URL}/api/merchant/registration`, { headers: auth });
    const step = (await get.json()).data;
    if (!step?.typedData) return step?.merchant?.registration?.state ?? "unknown";
    const t = step.typedData;
    const fields = t.types[t.primaryType];
    const message = Object.fromEntries(Object.entries(t.message).map(([k, v]) => [k, /^u?int\d*$/.test(fields.find((f) => f.name === k)?.type ?? "") ? BigInt(v) : v]));
    const { EIP712Domain: _unused, ...types } = t.types;
    const signature = await account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message });
    const post = await fetch(`${BUSINESS_URL}/api/merchant/registration`, { method: "POST", headers: auth, body: JSON.stringify({ signature, deadline: String(t.message.deadline) }) });
    const body = await post.json();
    if (!post.ok) throw new Error(`registration failed: ${JSON.stringify(body.error ?? body)}`);
    return body.data.merchant.registration.state;
  }

  const businessEnv = {
    ...process.env,
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    POLARIS_DEPLOYMENT_FILE: deploymentFile,
    POLARIS_RPC_URL: RPC,
    RELAYER_MODE: "local",
    RELAYER_PRIVATE_KEY: RELAYER.key,
    REGISTRY_ACTIVATOR: "local",
    REGISTRY_OWNER_PRIVATE_KEY: OWNER.key,
    POLARIS_DB_URL: dbUrl,
    POLARIS_KEY_PEPPER: secrets.pepper,
    POLARIS_DISABLE_PRIVY: "1",
    POLARIS_WEBHOOK_ALLOW_PRIVATE: "1",
    POLARIS_CHECKOUT_ORIGIN: APP_URL,
    POLARIS_PUBLIC_URL: BUSINESS_URL,
    POLARIS_APP_ORIGINS: `http://127.0.0.1:${PORTS.app}`,
    POLARIS_WORKERS: "1",
    PAY_IN_4_INTERVAL_SECONDS: process.env.DEMO_PAY_IN_4_INTERVAL_SECONDS || (FAST_PLANS ? "60" : "604800"),
    CRON_SECRET: secrets.cron,
    KEEPER_UNDERWRITING_URL: `http://127.0.0.1:${PORTS.keeper}/underwrite`,
    KEEPER_REQUEST_MIN_INTERVAL_MS: "2000",
    POLARIS_KEEPER_CALLBACK_SECRET: secrets.callback,
    POLARIS_LOCAL_SESSION_TOKEN: secrets.session,
    POLARIS_LOCAL_SESSION_WALLET: merchant.address,
    NEXT_PUBLIC_POLARIS_LOCAL_SESSION: secrets.session,
    NEXT_PUBLIC_POLARIS_LOCAL_SESSION_WALLET: merchant.address,
    NEXT_PUBLIC_POLARIS_LOCAL_SESSION_KEY: merchantKey,
    NEXT_PUBLIC_DEMO_SHOP_URL: SHOP_URL,
    NEXT_PUBLIC_CHAIN_ID: String(deployment.chainId),
    NEXT_PUBLIC_EXPLORER_URL: "",
    NEXT_PUBLIC_PRIVY_APP_ID: "",
  };
  log(`starting Polaris for Business on ${BUSINESS_URL}…`);
  background("business", process.execPath, [nextBin(BUSINESS), "dev", "--port", String(PORTS.business)], { cwd: BUSINESS, env: businessEnv });

  log(`starting the Polaris keeper (collections every minute, reviews on :${PORTS.keeper})…`);
  background("keeper", process.execPath, ["--conditions=source", "--disable-warning=ExperimentalWarning", join(KEEPER, "src", "main.ts")], {
    cwd: KEEPER,
    env: {
      ...process.env,
      POLARIS_DEPLOYMENT_FILE: deploymentFile,
      KEEPER_RPC_URL: RPC,
      POLARIS_KEEPER_PRIVATE_KEY: KEEPER_ACCOUNT.key,
      POLARIS_API_URL: BUSINESS_URL,
      POLARIS_KEEPER_CALLBACK_SECRET: secrets.callback,
      KEEPER_PORT: String(PORTS.keeper),
      KEEPER_BACKOFF: FAST_PLANS ? "off" : "",
      // The account under review is on this node: its tokens are the mocks.
      UNDERWRITING_ACCOUNT_CHAIN_ID: String(deployment.chainId),
      UNDERWRITING_ACCOUNT_RPC_URL: RPC,
      UNDERWRITING_ACCOUNT_EXPLORER_API_URL: "none",
      UNDERWRITING_ACCOUNT_TOKENS: `${at("USDC")},${at("EURC")}`,
    },
  });

  const appEnv = {
    ...process.env,
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_POLARIS_API_URL: BUSINESS_URL,
    NEXT_PUBLIC_DEV_SIGNER: "1",
    NEXT_PUBLIC_DEV_SIGNER_PERSIST: "1",
    NEXT_PUBLIC_CHAIN_ID: String(deployment.chainId),
    NEXT_PUBLIC_RPC_URL: RPC,
    NEXT_PUBLIC_EXPLORER_URL: "",
    NEXT_PUBLIC_USDC_ADDRESS: at("USDC"),
    NEXT_PUBLIC_EURC_ADDRESS: at("EURC"),
    NEXT_PUBLIC_SEND_EURC_ADDRESS: at("PolarisSendEURC"),
    NEXT_PUBLIC_PAYMENTS_ADDRESS: at("PolarisPayments"),
    NEXT_PUBLIC_CHECKOUT_ADDRESS: at("PolarisCheckout"),
    NEXT_PUBLIC_SEND_ADDRESS: at("PolarisSend"),
    NEXT_PUBLIC_SPLIT_ADDRESS: at("PolarisSplit"),
    NEXT_PUBLIC_LOAN_ENGINE_ADDRESS: at("PolarisLoanEngine"),
    NEXT_PUBLIC_LOCAL_DEMO: "1",
    NEXT_PUBLIC_LOCAL_FAUCET_URL: FAUCET_URL,
    NEXT_PUBLIC_PRIVY_APP_ID: "",
  };
  log(`starting the Polaris app on ${APP_URL}…`);
  background("app", process.execPath, [nextBin(APP), "dev", "--port", String(PORTS.app)], { cwd: APP, env: appEnv });

  const shopEnv = {
    ...process.env,
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(PORTS.shop),
    POLARIS_API_BASE: BUSINESS_URL,
    POLARIS_SECRET_KEY: seeded.secretKey,
    POLARIS_WEBHOOK_SECRET: seeded.webhookSecret,
    NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY: seeded.publishableKey,
    NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN: APP_URL,
    POLARIS_MERCHANT_ADDRESS: merchant.address,
    SHOP_URL,
    SHOP_DATA_DIR: join(DEMO, "shop"),
    POLARIS_LOCAL_CHAIN: JSON.stringify({
      chainId: deployment.chainId,
      name: "Local Hardhat",
      rpcUrl: RPC,
      explorer: "",
      stablecoin: at("USDC"),
      payments: at("PolarisPayments"),
      loanEngine: at("PolarisLoanEngine"),
      scoreManager: at("ScoreManager"),
      collateralVault: at("CollateralVault"),
      checkout: at("PolarisCheckout"),
      send: at("PolarisSend"),
      merchantRegistry: at("MerchantRegistry"),
      collector: at("CollectionsReceiver"),
      batchSettlement: at("BatchSettlement"),
    }),
  };
  log(`starting Halcyon, the demo shop, on ${SHOP_URL}…`);
  background("shop", process.execPath, [nextBin(SHOP), "dev", "-H", "127.0.0.1", "-p", String(PORTS.shop)], { cwd: SHOP, env: shopEnv });

  await startFaucet({ usdc: at("USDC"), eurc: at("EURC") }, mint);

  await until("Polaris for Business", async () => {
    const res = await fetch(`${BUSINESS_URL}/api/health`);
    const body = await res.json();
    return res.ok && body.data?.ok === true;
  }, STARTUP_MS);
  const registered = await registerMerchant(merchant);
  log(`registered ${MERCHANT_NAME} on MerchantRegistry through /api/merchant/registration: ${registered}`);
  await until("the Polaris app", async () => (await fetch(`${APP_URL}/`)).ok, STARTUP_MS);
  await until("the demo shop", async () => (await fetch(`${SHOP_URL}/`)).ok, STARTUP_MS);

  log("warming every page and API route once (so no first click waits for a compile)…");
  const business = await warm(BUSINESS_URL, ["/api/health", "/api/public/network", "/api/public/credit-guard", "/", "/dashboard", "/dashboard/payments", "/dashboard/plans", "/dashboard/automation", "/api/automation", "/api/overview"]);
  const shop = await warm(SHOP_URL, ["/shop", "/products/halcyon-one", "/cart", "/checkout"]);
  const app = await warm(APP_URL, ["/", "/onboard", "/pay", "/pay/cs_test_warmupwarmup", "/send", "/claim", "/add", "/receive", "/activity", "/credit", "/plans", "/accounts", "/settings"]);
  log(`warmed the dashboard in ${Math.round(business.ms / 1000)} s, the shop in ${Math.round(shop.ms / 1000)} s, the app in ${Math.round(app.ms / 1000)} s`);

  writeFileSync(
    join(DEMO, "demo.json"),
    JSON.stringify(
      {
        ports: PORTS,
        chain: "hardhat",
        devSigner: true,
        stablecoin: "MockUSDC (local only; USDC on Arc)",
        keeper: KEEPER_ACCOUNT.address,
        relayer: RELAYER.address,
        fastPlans: FAST_PLANS,
        urls: { business: BUSINESS_URL, dashboard: `${BUSINESS_URL}/dashboard`, app: APP_URL, shop: SHOP_URL, faucet: `${FAUCET_URL}/mint`, rpc: RPC, keeper: `http://127.0.0.1:${PORTS.keeper}` },
        chainId: deployment.chainId,
        contracts: Object.fromEntries(Object.entries(deployment.contracts).map(([k, v]) => [k, v.address])),
        merchant: { address: merchant.address, name: MERCHANT_NAME, publicId: seeded.merchant.publicId, registration: registered },
      },
      null,
      2,
    ),
  );

  console.log(`
Polaris is running locally (chain ${deployment.chainId}, a Hardhat node; MockUSDC and MockEURC stand in for Circle's tokens).

  Demo shop      ${SHOP_URL}             add to the bag, check out with Polaris
  Polaris app    ${APP_URL}              the checkout sheet (dev signer in place of Face ID)
  Dashboard      ${BUSINESS_URL}/dashboard   ${MERCHANT_NAME}, signed in locally (registered on chain: ${registered})
  Faucet         POST ${FAUCET_URL}/mint {"address": "0x…"}   (or Add money in the app)
  Keeper         http://127.0.0.1:${PORTS.keeper}/health   collections every minute (.demo/logs/keeper.log)
  Chain          ${RPC}

Pay in 4 needs a credit line: Boost (lock dollars in the app) raises it at face
value; "Raise your limit" asks the keeper for a review, which on this node
finds no history and says so. Instalments are ${FAST_PLANS ? "a minute apart (DEMO_FAST_PLANS=1)" : "a week apart (DEMO_FAST_PLANS=1 makes them a minute)"}.
Logs: .demo/logs. Ctrl+C stops everything.
`);
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`[demo] ${error.message ?? error}`);
  stop();
  process.exit(1);
});
