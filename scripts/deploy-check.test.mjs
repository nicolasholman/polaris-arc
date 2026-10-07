// node --test scripts/deploy-check.test.mjs
//
// scripts/deploy-check.mjs against a fake deployment: every check's pass and
// failure paths, with a fetch that answers the way the four apps do.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  FAIL,
  inspectAssetLinks,
  loadDeployment,
  parseArgs,
  parseSdkPreset,
  PASS,
  REPO,
  rpIdFits,
  runDeployCheck,
  SKIP,
  UsageError,
  WARN,
} from "./deploy-check.mjs";

const RECORD = join(REPO, "packages", "contracts", "deployments", "monad-testnet.json");
const deployment = loadDeployment(RECORD);
const C = deployment.contracts;

const URLS = {
  app: "https://app.polaris.test",
  business: "https://business.polaris.test",
  landing: "https://polaris.test",
  shop: "https://shop.polaris.test",
};

const PRINT = Array.from({ length: 32 }, () => "AB").join(":");

/** A healthy deployment's answers; each test breaks one thing. */
function healthyState() {
  return {
    app: {
      service: "polaris-app",
      ok: true,
      production: true,
      devSigner: false,
      devSignerPersist: false,
      localDemo: false,
      localFaucet: false,
      target: "web",
      chainId: 10143,
      apiUrl: URLS.business,
      rpId: "polaris.test",
      privyAppId: "privy-app",
      pinnedContracts: {},
    },
    assetlinks: null,
    business: {
      ok: true,
      chain: {
        id: 10143,
        name: "Monad Testnet",
        contracts: {
          stablecoin: C.Stablecoin,
          checkout: C.PolarisCheckout,
          payments: C.PolarisPayments,
          send: C.PolarisSend,
          loanEngine: C.PolarisLoanEngine,
          registry: C.MerchantRegistry,
          scoreManager: C.ScoreManager,
          collections: C.CollectionsReceiver,
          underwriting: C.UnderwritingReceiver,
          guardian: C.GuardianReceiver,
        },
      },
      chainProblem: null,
      relayer: { mode: "privy", address: "0x5e6934725eBCdfcA2d95D991045Fa813B51E2c69" },
      activator: "off",
      automaticPayouts: false,
      checkoutOrigin: URLS.app,
      publicUrl: URLS.business,
      appOrigins: [URLS.app],
      productionReady: true,
      build: {
        production: true,
        devMockSession: false,
        localSession: false,
        privy: true,
        privyAppId: "privy-app",
        privyServerAppId: "privy-app",
        demoShopUrl: URLS.shop,
        workers: true,
      },
    },
    ready: {
      ready: true,
      checks: {
        config: { ok: true, detail: "The environment parses." },
        chain: { ok: true, id: 10143, detail: "Monad Testnet (10143)" },
        store: { ok: true, kind: "sqlite", persistent: true, path: "/data/polaris.db", detail: "SQLite at /data/polaris.db" },
        workers: { ok: true, enabled: true, running: true, detail: "running" },
      },
      relayer: { mode: "privy" },
      sync: { block: 66400000, updatedAt: "2026-10-01T00:00:00Z", ageSeconds: 3 },
    },
    network: {
      chainId: 10143,
      contracts: {
        stablecoin: C.Stablecoin,
        payments: C.PolarisPayments,
        checkout: C.PolarisCheckout,
        send: C.PolarisSend,
        loanEngine: C.PolarisLoanEngine,
        registry: C.MerchantRegistry,
      },
      relayer: { available: true },
    },
    appOrigins: [URLS.app],
    meStatus: 401,
    tickStatus: 401,
    shop: {
      ok: true,
      service: "halcyon-shop",
      production: true,
      polaris: {
        configured: true,
        apiBase: URLS.business,
        checkoutOrigin: URLS.app,
        relayUrl: `${URLS.business}/api/v1/relay/payments`,
        merchant: deployment.demoMerchant,
        publishableKeyMode: "test",
      },
      shopUrl: URLS.shop,
      orderStore: { kind: "redis", serverless: true },
    },
    webhookStatus: 400,
    landingHtml: `<html><title>Polaris</title><a href="${URLS.app}">Get the app</a><a href="${URLS.business}/login">Log in</a></html>`,
    hsts: true,
    httpRedirect: true,
    unreachable: new Set(),
  };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fakeFetch(state) {
  const base = () => ({
    "x-content-type-options": "nosniff",
    ...(state.hsts ? { "strict-transport-security": "max-age=63072000" } : {}),
  });
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const origin = new Headers(init.headers).get("origin");
    const key = Object.entries(URLS).find(([, u]) => new URL(u).host === url.host)?.[0];
    if (!key || state.unreachable.has(key)) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    if (url.protocol === "http:") {
      return state.httpRedirect
        ? new Response(null, { status: 308, headers: { location: `https://${url.host}${url.pathname}` } })
        : new Response("plain", { status: 200 });
    }
    const path = url.pathname;
    if (key === "app") {
      if (path === "/") return new Response("<html>Polaris</html>", { headers: { ...base(), "x-frame-options": "DENY", "content-type": "text/html" } });
      if (path === "/api/health") return json(state.app);
      if (path === "/manifest.webmanifest") return json({ name: "Polaris" });
      if (path === "/.well-known/assetlinks.json" && state.assetlinks) return json(state.assetlinks);
      return new Response("not found", { status: 404 });
    }
    if (key === "business") {
      if (method === "OPTIONS") {
        const anyOrigin = path === "/api/v1/relay/payments";
        const allowed = anyOrigin ? "*" : state.appOrigins.includes(origin) ? origin : null;
        return new Response(null, { status: allowed ? 204 : 403, headers: allowed ? { "access-control-allow-origin": allowed } : {} });
      }
      if (path === "/") return new Response("<html>Polaris for Business</html>", { headers: base() });
      if (path === "/api/health") return json({ data: state.business });
      if (path === "/api/health/ready") return json({ data: state.ready }, state.ready.ready ? 200 : 503);
      if (path === "/api/public/network") return json({ data: state.network });
      if (path === "/api/me") return json({ error: { code: "unauthenticated" } }, state.meStatus);
      if (path === "/api/cron/tick") return json({ error: { code: "unauthenticated" } }, state.tickStatus);
      return new Response("not found", { status: 404 });
    }
    if (key === "shop") {
      if (path === "/") return new Response("<html>Halcyon</html>", { headers: base() });
      if (path === "/api/health") return json(state.shop);
      if (path === "/api/webhooks/polaris") return json({ error: "invalid signature" }, state.webhookStatus);
      return new Response("not found", { status: 404 });
    }
    if (path === "/") return new Response(state.landingHtml, { headers: { ...base(), "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  };
}

async function run(mutate = () => {}, options = {}) {
  const state = healthyState();
  mutate(state);
  const results = await runDeployCheck(
    { urls: URLS, allowHttp: false, androidPackage: null, cronSecret: null, chainId: 10143, timeoutMs: 5_000, deployment: RECORD, json: false, ...options },
    { fetch: fakeFetch(state) },
  );
  const find = (target, id) => results.filter((r) => r.target === target && r.id === id);
  const status = (target, id) => {
    const rows = find(target, id);
    assert.ok(rows.length > 0, `no ${target}/${id} result`);
    return rows.some((r) => r.status === FAIL) ? FAIL : rows.some((r) => r.status === WARN) ? WARN : rows[0].status;
  };
  return { results, status, find };
}

describe("a healthy deployment", () => {
  it("passes every check (assetlinks skipped: no Android app)", async () => {
    const { results } = await run();
    const notPassing = results.filter((r) => r.status !== PASS);
    assert.deepEqual(
      notPassing.map((r) => `${r.target}/${r.id}: ${r.status}`),
      ["app/assetlinks: skip"],
    );
  });
});

describe("the app", () => {
  it("fails a build with the dev signer or a local demo switch", async () => {
    const { status, find } = await run((s) => {
      s.app.devSigner = true;
      s.app.localFaucet = true;
    });
    assert.equal(status("app", "dev-signer"), FAIL);
    assert.match(find("app", "dev-signer")[0].message, /devSigner, localFaucet/);
  });

  it("fails an app pointed at another API, chain or an unusable relying party", async () => {
    const { status } = await run((s) => {
      s.app.apiUrl = "https://elsewhere.test";
      s.app.chainId = 143;
      s.app.rpId = "polarispay.app";
    });
    assert.equal(status("app", "api-url"), FAIL);
    assert.equal(status("app", "chain"), FAIL);
    assert.equal(status("app", "rp-id"), FAIL);
  });

  it("warns when the relying party is left to the hostname", async () => {
    const { status } = await run((s) => {
      s.app.rpId = null;
    });
    assert.equal(status("app", "rp-id"), WARN);
  });

  it("fails a build without the API, which only says Polaris isn't configured", async () => {
    const { status, find } = await run((s) => {
      s.app.apiUrl = null;
    });
    assert.equal(status("app", "api-url"), FAIL);
    assert.match(find("app", "api-url")[0].message, /Polaris isn't configured on this build/);
    assert.doesNotMatch(find("app", "api-url")[0].message, /offline demo/);
  });

  it("fails a pinned contract that isn't the deployment's", async () => {
    const { status } = await run((s) => {
      s.app.pinnedContracts = { checkout: "0x0000000000000000000000000000000000000001" };
    });
    assert.equal(status("app", "pinned-contracts"), FAIL);
  });

  it("fails an older build without /api/health", async () => {
    const { status } = await run((s) => {
      s.app = { nope: true };
    });
    assert.equal(status("app", "health"), FAIL);
  });

  it("checks assetlinks.json when served, and requires it for --android-package", async () => {
    const statement = (pkg, prints = [PRINT]) => ({
      relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
    });
    assert.equal((await run((s) => (s.assetlinks = [statement("app.polaris.pay")]))).status("app", "assetlinks"), PASS);
    assert.equal((await run((s) => (s.assetlinks = [statement("app.polaris.pay", ["ab:cd"])]))).status("app", "assetlinks"), FAIL);
    assert.equal((await run(() => {}, { androidPackage: "app.polaris.pay" })).status("app", "assetlinks"), FAIL);
    assert.equal((await run((s) => (s.assetlinks = [statement("other.app")]), { androidPackage: "app.polaris.pay" })).status("app", "assetlinks"), FAIL);
    assert.equal((await run()).status("app", "assetlinks"), SKIP);
  });
});

describe("Polaris for Business", () => {
  it("fails a checkout origin or public URL that isn't the deployment's", async () => {
    const { status } = await run((s) => {
      s.business.checkoutOrigin = "http://localhost:3000";
      s.business.publicUrl = null;
    });
    assert.equal(status("business", "checkout-origin"), FAIL);
    assert.equal(status("business", "public-url"), FAIL);
  });

  it("fails a dev session, a relayer that's off, and a missing Privy build argument", async () => {
    const { status } = await run((s) => {
      s.business.build.devMockSession = true;
      s.business.relayer = { mode: "off", address: null };
      s.business.build.privyAppId = null;
    });
    assert.equal(status("business", "dev-session"), FAIL);
    assert.equal(status("business", "relayer"), FAIL);
    assert.equal(status("business", "privy"), FAIL);
  });

  it("warns about the dev relayer, which the testnet demo runs on", async () => {
    const { status } = await run((s) => {
      s.business.relayer = { mode: "local", address: "0x5e6934725eBCdfcA2d95D991045Fa813B51E2c69" };
    });
    assert.equal(status("business", "relayer"), WARN);
  });

  it("fails contracts that aren't the deployment record's", async () => {
    const { status, find } = await run((s) => {
      s.business.chain.contracts.checkout = "0x0000000000000000000000000000000000000002";
    });
    assert.equal(status("business", "contracts"), FAIL);
    assert.match(find("business", "contracts")[0].message, /PolarisCheckout/);
  });

  it("fails a store in memory and a server that isn't ready", async () => {
    const { status } = await run((s) => {
      s.ready.ready = false;
      s.ready.checks.store = { ok: true, kind: "memory", persistent: false, path: null, detail: "In memory" };
      s.ready.checks.workers = { ok: false, enabled: true, running: false, detail: "not started" };
    });
    assert.equal(status("business", "store"), FAIL);
    assert.equal(status("business", "ready"), FAIL);
  });

  it("warns when the chain sync is stale", async () => {
    const { status } = await run((s) => {
      s.ready.sync.ageSeconds = 900;
    });
    assert.equal(status("business", "chain-sync"), WARN);
  });

  it("fails CORS that refuses the app, or lets anyone call the relayer", async () => {
    assert.equal((await run((s) => (s.appOrigins = []))).status("business", "cors"), FAIL);
    assert.equal((await run((s) => (s.appOrigins = [URLS.app, "https://deploy-check.invalid"]))).status("business", "cors-strangers"), FAIL);
  });

  it("fails an open dashboard session or cron route", async () => {
    const { status } = await run((s) => {
      s.meStatus = 200;
      s.tickStatus = 200;
    });
    assert.equal(status("business", "dashboard-auth"), FAIL);
    assert.equal(status("business", "cron-auth"), FAIL);
  });

  it("doesn't fail the dev relayer twice: it is a relayer warning, not a production failure", async () => {
    const devRelayer = (s) => {
      s.business.relayer = { mode: "local", address: "0x5e6934725eBCdfcA2d95D991045Fa813B51E2c69" };
      s.business.productionReady = false;
    };
    const listed = await run((s) => {
      devRelayer(s);
      s.business.problems = ["The relayer signs with a raw key."];
    });
    assert.equal(listed.status("business", "production-ready"), PASS);
    assert.equal(listed.status("business", "relayer"), WARN);
    assert.equal((await run(devRelayer)).status("business", "production-ready"), WARN);
    const more = await run((s) => {
      devRelayer(s);
      s.business.problems = ["The relayer signs with a raw key.", "CRON_SECRET is not set: the cron routes are closed."];
    });
    assert.equal(more.status("business", "production-ready"), FAIL);
    assert.doesNotMatch(more.find("business", "production-ready")[0].message, /raw key/);
  });

  it("fails production problems, and lists them with the cron secret", async () => {
    const { find } = await run((s) => {
      s.business.productionReady = false;
      s.business.problems = ["POLARIS_KEY_PEPPER is not set."];
    });
    assert.equal(find("business", "production-ready")[0].status, FAIL);
    assert.match(find("business", "production-ready")[0].message, /POLARIS_KEY_PEPPER/);
  });
});

describe("the shop", () => {
  it("fails a serverless shop without Redis, a development build, a wrong API or checkout", async () => {
    const { status } = await run((s) => {
      s.shop.orderStore = { kind: "file", serverless: true };
      s.shop.production = false;
      s.shop.polaris.apiBase = "http://localhost:3100";
      s.shop.polaris.checkoutOrigin = "http://localhost:3000";
      s.shop.shopUrl = null;
    });
    assert.equal(status("shop", "order-store"), FAIL);
    assert.equal(status("shop", "production"), FAIL);
    assert.equal(status("shop", "polaris"), FAIL);
    assert.equal(status("shop", "checkout-origin"), FAIL);
    assert.equal(status("shop", "shop-url"), FAIL);
  });

  it("fails a shop whose payments are off, and one that accepts an unsigned webhook", async () => {
    const { status } = await run((s) => {
      s.shop.polaris = { configured: false, reason: "Set SHOP_URL to take payments through Polaris." };
      s.webhookStatus = 200;
    });
    assert.equal(status("shop", "polaris"), FAIL);
    assert.equal(status("shop", "webhook"), FAIL);
  });

  it("accepts the file store on a long-lived host", async () => {
    const { status } = await run((s) => {
      s.shop.orderStore = { kind: "file", serverless: false };
    });
    assert.equal(status("shop", "order-store"), PASS);
  });
});

describe("transport", () => {
  it("fails an app that doesn't answer, and warns without HSTS or an HTTP redirect", async () => {
    const { status, find } = await run((s) => {
      s.unreachable.add("landing");
      s.hsts = false;
      s.httpRedirect = false;
    });
    assert.equal(status("landing", "reachable"), FAIL);
    assert.match(find("landing", "reachable")[0].message, /ENOTFOUND/);
    assert.equal(status("app", "hsts"), WARN);
    assert.equal(status("shop", "http-redirect"), WARN);
  });

  it("warns on the landing page's missing links", async () => {
    const { status } = await run((s) => {
      s.landingHtml = "<html>Polaris</html>";
    });
    assert.equal(status("landing", "links-app"), WARN);
  });
});

describe("the SDK presets", () => {
  it("match the committed deployment record", async () => {
    const preset = parseSdkPreset(readFileSync(join(REPO, "packages", "sdk", "src", "deployments.ts"), "utf8"));
    assert.equal(preset.chainId, 10143);
    assert.equal(preset.stablecoin, C.Stablecoin);
    assert.equal(preset.contracts.checkout, C.PolarisCheckout);
    assert.equal(preset.contracts.merchantRegistry, C.MerchantRegistry);
  });

  it("fail when the live API serves another deployment", async () => {
    const { status } = await run((s) => {
      s.network.contracts.checkout = "0x0000000000000000000000000000000000000003";
    });
    assert.equal(status("sdk", "presets-live"), FAIL);
  });

  it("fail when the SDK and the record disagree", () => {
    const source = readFileSync(join(REPO, "packages", "sdk", "src", "deployments.ts"), "utf8").replace(C.PolarisSend, "0x0000000000000000000000000000000000000004");
    assert.notEqual(parseSdkPreset(source).contracts.send, C.PolarisSend);
  });
});

describe("helpers", () => {
  it("rpIdFits: the host or a registrable domain above it", () => {
    assert.equal(rpIdFits("polarispay.app", "app.polarispay.app"), true);
    assert.equal(rpIdFits("polarispay.app", "polarispay.app"), true);
    assert.equal(rpIdFits("polaris-app.vercel.app", "polaris-app.vercel.app"), true);
    assert.equal(rpIdFits("polarispay.app", "polaris-app.vercel.app"), false);
    assert.equal(rpIdFits("app", "polarispay.app"), false);
    // A platform's shared domain is a public suffix: no relying party may claim it.
    assert.equal(rpIdFits("vercel.app", "polaris-app.vercel.app"), false);
  });

  it("inspectAssetLinks: shape problems", () => {
    assert.deepEqual(inspectAssetLinks({}).problems, ["it is not a JSON array of statements"]);
    assert.deepEqual(inspectAssetLinks([]).problems, ["it names no android_app target"]);
  });

  it("parseArgs: URLs from flags or the environment, HTTPS unless allowed", () => {
    const env = { POLARIS_APP_URL: "https://a.test/x", POLARIS_BUSINESS_URL: "https://b.test", POLARIS_LANDING_URL: "https://l.test", POLARIS_SHOP_URL: "https://s.test" };
    const parsed = parseArgs([], env);
    assert.deepEqual(parsed.urls, { app: "https://a.test", business: "https://b.test", landing: "https://l.test", shop: "https://s.test" });
    assert.equal(parsed.chainId, 10143);
    assert.throws(() => parseArgs(["--app", "http://a.test"], env), UsageError);
    assert.equal(parseArgs(["--app=http://localhost:3930", "--allow-http"], env).urls.app, "http://localhost:3930");
    assert.throws(() => parseArgs(["--shop"], env), /needs a value/);
    assert.throws(() => parseArgs(["--nope"], env), /Unknown option/);
    assert.equal(parseArgs(["--", "--app", "https://a2.test"], env).urls.app, "https://a2.test");
    assert.throws(() => parseArgs([], {}), /--app/);
    assert.equal(parseArgs(["--android-package", "app.polaris.pay", "--cron-secret", "s"], env).androidPackage, "app.polaris.pay");
  });
});
