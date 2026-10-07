#!/usr/bin/env node
// Create a local merchant with API keys, without a Privy login.
//
//   pnpm --filter @polaris/business dev:merchant -- [--wallet 0x…] [--name "Studio"] [--webhook http://127.0.0.1:4000/hook]
//
// Defaults: the demo merchant from packages/contracts/deployments/monad-local.json
// (registered and activated by `deploy:local`), and the database the dev
// server uses (POLARIS_DB_URL, default sqlite:.data/polaris.db). Prints the
// sk_test_/pk_test_ keys and the webhook secret once. Refuses in production.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { APP_DIR, REPO_DIR, loadEnv, option } from "./privy/lib.mjs";
import { seedMerchant } from "./lib/seed.mjs";

const env = loadEnv();
const localDeployment = join(REPO_DIR, "packages", "contracts", "deployments", "monad-local.json");
let wallet = option("wallet");
let name = option("name", "Polaris Demo Studio");
let registration = "none";
if (!wallet && existsSync(localDeployment)) {
  const d = JSON.parse(readFileSync(localDeployment, "utf8"));
  wallet = d.demo?.merchant;
  name = option("name", d.demo?.merchantName ?? name);
  registration = "active";
}
if (!wallet) throw new Error("Pass --wallet 0x…, or run `pnpm --filter @polarispay/contracts deploy:local` first for the demo merchant.");

const dbUrl = env.POLARIS_DB_URL ?? `sqlite:${join(APP_DIR, ".data", "polaris.db")}`;
const out = await seedMerchant({ dbUrl, pepper: env.POLARIS_KEY_PEPPER, wallet, name, webhookUrl: option("webhook"), registration });

console.log(`Merchant ${out.merchant.publicId} (${name}), wallet ${wallet}, in ${dbUrl}`);
console.log(`  POLARIS_SECRET_KEY=${out.secretKey}`);
console.log(`  NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY=${out.publishableKey}`);
if (out.webhookSecret) console.log(`  POLARIS_WEBHOOK_SECRET=${out.webhookSecret}`);
console.log("These are shown once. The server stores only a hash of the secret key.");
