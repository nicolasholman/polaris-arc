#!/usr/bin/env node
// Read back, from Privy, what setup-relayer and setup-payouts created: the
// relayer and registry admin wallets (owner, policies, additional signers),
// the key quorums, and each policy exactly as Privy holds it. Reads only; no
// secret is involved or printed (ids, addresses, public rules).
//
//   pnpm --filter @polaris/business privy:show                 # prints it
//   pnpm --filter @polaris/business privy:show -- --write      # also writes docs/demo/testnet/privy-live.json

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_DIR, flag, loadEnv, privyClient } from "./lib.mjs";

const env = loadEnv();
const need = ["PRIVY_RELAYER_WALLET_ID", "PRIVY_ADMIN_QUORUM_ID"];
for (const k of need) if (!env[k]) throw new Error(`${k} is not set: run privy:setup-relayer -- --apply first.`);
const privy = await privyClient(env);

/** A wallet as the record keeps it: who owns it, which policies hold it, who else may sign. */
async function wallet(id) {
  const w = await privy.wallets().get(id);
  return {
    id: w.id,
    address: w.address,
    chain_type: w.chain_type,
    owner_id: w.owner_id ?? null,
    policy_ids: w.policy_ids ?? [],
    additional_signers: (w.additional_signers ?? []).map((s) => ({ signer_id: s.signer_id, override_policy_ids: s.override_policy_ids ?? [] })),
    created_at: w.created_at ?? null,
  };
}

async function quorum(id) {
  const q = await privy.keyQuorums().get(id);
  return { id: q.id, display_name: q.display_name ?? null, authorization_threshold: q.authorization_threshold ?? null, keys: (q.authorization_keys ?? []).length };
}

const wallets = { relayer: await wallet(env.PRIVY_RELAYER_WALLET_ID) };
if (env.PRIVY_REGISTRY_WALLET_ID) wallets.registryAdmin = await wallet(env.PRIVY_REGISTRY_WALLET_ID);
const quorumIds = new Set([env.PRIVY_ADMIN_QUORUM_ID, ...(env.PRIVY_PAYOUT_SIGNER_ID ? [env.PRIVY_PAYOUT_SIGNER_ID] : [])]);
for (const w of Object.values(wallets)) {
  if (w.owner_id) quorumIds.add(w.owner_id);
  for (const s of w.additional_signers) quorumIds.add(s.signer_id);
}
const quorums = [];
for (const id of quorumIds) quorums.push(await quorum(id));
const policyIds = new Set(Object.values(wallets).flatMap((w) => [...w.policy_ids, ...w.additional_signers.flatMap((s) => s.override_policy_ids)]));
const policies = [];
for (const id of policyIds) policies.push(await privy.policies().get(id));

const out = {
  readAt: new Date().toISOString(),
  appId: env.PRIVY_APP_ID || env.NEXT_PUBLIC_PRIVY_APP_ID,
  note: "Read back from Privy by scripts/privy/show-live.mjs. Ids and public rules only; the authorization keys are in git-ignored files.",
  wallets,
  keyQuorums: quorums,
  payoutSigner: env.PRIVY_PAYOUT_SIGNER_ID ?? null,
  policies,
};
const json = JSON.stringify(out, null, 2);
if (flag("write")) {
  const dir = join(REPO_DIR, "docs", "demo", "testnet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "privy-live.json"), `${json}\n`);
  console.log(`Wrote ${join(dir, "privy-live.json")}`);
}
for (const [name, w] of Object.entries(wallets)) {
  console.log(`${name.padEnd(14)} ${w.id}  ${w.address}  owner ${w.owner_id}  policies ${w.policy_ids.join(",")}  signers ${w.additional_signers.map((s) => s.signer_id).join(",")}`);
}
for (const q of quorums) console.log(`key quorum     ${q.id}  ${q.display_name ?? ""}  threshold ${q.authorization_threshold}, ${q.keys} key(s)`);
for (const p of policies) console.log(`policy         ${p.id}  ${p.name}  ${p.rules.length} rules, owner ${p.owner_id ?? "?"}`);
