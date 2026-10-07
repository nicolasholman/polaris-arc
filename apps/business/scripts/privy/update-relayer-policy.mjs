#!/usr/bin/env node
// Replace the live relayer policy's rules with the ones the deployment record
// now calls for, in place: same policy id, same wallet, same owner. For a
// contract that moved (a CollateralVault redeploy changes the address every
// vault rule pins) or a call that was added (CollateralVault.withdrawWithSig).
//
//   pnpm --filter @polaris/business privy:update-relayer-policy            # dry run: prints the rules, calls nothing
//   pnpm --filter @polaris/business privy:update-relayer-policy -- --apply # updates the policy in Privy
//
// Options: --deployment <name> (default monad-testnet).
//
// --apply needs, besides PRIVY_APP_ID and PRIVY_APP_SECRET, the policy's id
// (PRIVY_RELAYER_POLICY_ID, which setup-relayer wrote to .env.privy) and the
// admin key quorum's private key, the only key that may change the policy:
// apps/business/.privy-admin.key (PRIVY_ADMIN_PRIVATE_KEY), put back for this
// run only and deleted after. Nothing here prints a key.
//
// Then: `privy:show` (the live policy, rule by rule) and
// `privy:prove-policy -- --run` (Privy signs the allowed calls, refuses the rest).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { APP_DIR, banner, flag, loadDeployment, loadEnv, parseEnvFile, privyClient } from "./lib.mjs";
import { buildRelayerPolicy, callsFor, lintPolicy } from "../../src/server/policy/relayer.ts";

const apply = flag("apply");
const env = loadEnv();
const deployment = loadDeployment(env);
const minAmountUnits = BigInt(env.RELAYER_MIN_TRANSFER_UNITS ?? "100000");
const policy = buildRelayerPolicy({ chainId: deployment.chainId, addresses: deployment.addresses, minAmountUnits });
const problems = lintPolicy(policy);
if (problems.length) throw new Error(`Policy ${policy.name} is invalid: ${problems.join("; ")}`);

banner(`Relayer policy for chain ${deployment.chainId}, from ${deployment.file}`);
for (const c of callsFor(deployment.addresses)) console.log(`  ALLOW  ${c.contract.padEnd(10)} ${c.functionName.padEnd(28)} ${deployment.addresses[c.contract]}`);
console.log("  DENY   any transaction that carries MON");
if (deployment.addresses.vault && !deployment.vaultWithdraw) {
  console.log("\n  Note: the record's vault predates withdrawWithSig (no eip712.CollateralVault): its rule is harmless there (no such");
  console.log("  function, so no call to it can succeed), and the relayer refuses the call first.");
}

if (!apply) {
  banner("Rules (JSON, as they will replace the live policy's)");
  console.log(JSON.stringify(policy.rules, null, 2));
  console.log("\nNothing was sent. Re-run with --apply to update the policy in Privy.");
  process.exit(0);
}

const policyId = env.PRIVY_RELAYER_POLICY_ID;
if (!policyId) throw new Error("Set PRIVY_RELAYER_POLICY_ID (setup-relayer wrote it to apps/business/.env.privy).");
const adminFile = join(APP_DIR, ".privy-admin.key");
const adminKey = env.PRIVY_ADMIN_PRIVATE_KEY ?? (existsSync(adminFile) ? parseEnvFile(adminFile).PRIVY_ADMIN_PRIVATE_KEY : undefined);
if (!adminKey) throw new Error(`The admin key quorum's private key is needed: put it in ${adminFile} (PRIVY_ADMIN_PRIVATE_KEY) for this run, and delete the file after.`);

const privy = await privyClient(env);
const before = await privy.policies().get(policyId);
console.log(`\nLive policy ${before.id} "${before.name}": ${before.rules.length} rules`);
const updated = await privy.policies().update(policyId, { rules: policy.rules, authorization_context: { authorization_private_keys: [adminKey] } });
console.log(`Updated  ${updated.id} "${updated.name}": ${updated.rules.length} rules`);
const was = new Set(before.rules.map((r) => r.name));
for (const r of updated.rules) if (!was.has(r.name)) console.log(`  added  ${r.name}`);
const now = new Set(updated.rules.map((r) => r.name));
for (const r of before.rules) if (!now.has(r.name)) console.log(`  gone   ${r.name}`);
console.log("\nNext: delete the admin key file, then `privy:show` and `privy:prove-policy -- --run`.");
