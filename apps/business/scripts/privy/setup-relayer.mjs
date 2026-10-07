#!/usr/bin/env node
// Create the Polaris relayer in your Privy app: a policy-locked server wallet
// that carries every buyer action to Monad (docs/research/privy.md §5.5, §7).
//
//   pnpm --filter @polaris/business privy:setup-relayer            # dry run: prints the plan and the policy, calls nothing
//   pnpm --filter @polaris/business privy:setup-relayer -- --apply # creates it in your Privy app
//
// Options: --deployment <name> (default monad-testnet), --registry-admin (also
// create the registry admin wallet that activates merchants).
//
// What --apply creates, in this order:
//   1. an `admin` key quorum (a P-256 key generated here). It owns the wallet
//      and every policy, so no server key can widen them. Its private key is
//      written ONCE to apps/business/.privy-admin.key (mode 0600, git-ignored),
//      never to the terminal, where scrollback and CI logs would keep it: move
//      it offline (a password manager) and delete the file.
//   2. a `relayer` key quorum: the key the server signs Privy requests with.
//   3. the relayer policy (src/server/policy/relayer.ts): DENY any MON, and
//      one ALLOW per call the relayer carries, on this chain, to our
//      contracts, for one function each. Everything else is denied by default.
//   4. the relayer wallet, owned by `admin`, with the policy attached and the
//      `relayer` quorum as an additional signer under the same policy.
//   5. (--registry-admin) the same shape for the wallet that activates
//      merchants: setActive, and setMaxOrderValue up to the cap, nothing else.
//
// It writes the server's side (wallet ids, addresses, the relayer and registry
// keys) to apps/business/.env.privy (git-ignored), and prints the next steps:
// fund the relayer with testnet MON and grant it its contract roles.

import { banner, flag, loadDeployment, loadEnv, mask, privyClient, writeAdminKey, writeEnvPrivy } from "./lib.mjs";
import { buildRegistryAdminPolicy, buildRelayerPolicy, callsFor, lintPolicy } from "../../src/server/policy/relayer.ts";

const apply = flag("apply");
const withRegistry = flag("registry-admin");
const env = loadEnv();
const deployment = loadDeployment(env);
const capUnits = BigInt(env.MERCHANT_ACTIVATION_CAP_USD ?? "1000") * 1_000_000n;

// The smallest AUSD transfer or send by link the relayer signs (the server applies the same floor).
const minAmountUnits = BigInt(env.RELAYER_MIN_TRANSFER_UNITS ?? "100000");
const relayerPolicy = buildRelayerPolicy({ chainId: deployment.chainId, addresses: deployment.addresses, minAmountUnits });
const registryPolicy = buildRegistryAdminPolicy({ chainId: deployment.chainId, registry: deployment.addresses.registry, capUnits });
for (const p of [relayerPolicy, registryPolicy]) {
  const problems = lintPolicy(p);
  if (problems.length) throw new Error(`Policy ${p.name} is invalid: ${problems.join("; ")}`);
}

banner(`Polaris relayer on chain ${deployment.chainId}`);
console.log(`Contracts from ${deployment.file}
`);
console.log("The relayer may sign exactly these calls (eth_signTransaction, value 0):");
for (const c of callsFor(deployment.addresses)) console.log(`  ALLOW  ${c.contract.padEnd(10)} ${c.functionName.padEnd(28)} ${c.why}`);
console.log(`  (transferWithAuthorization and PolarisSend.send only for ${minAmountUnits} base units or more)`);
if (!deployment.addresses.split) console.log("  (no PolarisSplit in this deployment: its three calls are left out until deploy-split)");
console.log("  DENY   any transaction that carries MON");
console.log("  DENY   everything else (no rule matches → Privy denies)");

if (!apply) {
  banner("Relayer policy (JSON, as it will be created)");
  console.log(JSON.stringify(relayerPolicy, null, 2));
  if (withRegistry) {
    banner("Registry admin policy");
    console.log(JSON.stringify(registryPolicy, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }
  console.log("\nDry run: nothing was created. Re-run with --apply to create it in your Privy app.");
  process.exit(0);
}

const privy = await privyClient(env);
// Idempotency keys make a retried request safe within this run, not across runs.
const runId = Date.now().toString(36);
const { generateP256KeyPair } = await import("@privy-io/node");

async function quorum(displayName) {
  const { privateKey, publicKey } = await generateP256KeyPair();
  const q = await privy.keyQuorums().create({ public_keys: [publicKey], authorization_threshold: 1, display_name: displayName });
  return { id: q.id, privateKey };
}

async function lockedWallet(label, policyBody, admin, signer) {
  const policy = await privy.policies().create({ ...policyBody, owner_id: admin.id, idempotency_key: `${policyBody.name}-policy-${runId}` });
  const wallet = await privy.wallets().create({
    chain_type: "ethereum",
    owner_id: admin.id,
    policy_ids: [policy.id],
    additional_signers: [{ signer_id: signer.id, override_policy_ids: [policy.id] }],
    display_name: label,
    idempotency_key: `${policyBody.name}-wallet-${runId}`,
  });
  return { policy, wallet };
}

banner("Creating in Privy");
const admin = env.PRIVY_ADMIN_QUORUM_ID ? { id: env.PRIVY_ADMIN_QUORUM_ID, privateKey: null } : await quorum("polaris-admin");
// Saved before anything else is created, so a failure below can't lose the only key that owns it all.
const adminKeyFile = admin.privateKey ? writeAdminKey(admin.id, admin.privateKey) : null;
console.log(`  admin key quorum     ${admin.id}${admin.privateKey ? " (new)" : " (from PRIVY_ADMIN_QUORUM_ID)"}`);
const relayerSigner = await quorum("polaris-relayer");
console.log(`  relayer key quorum   ${relayerSigner.id}`);
const relayer = await lockedWallet("polaris-relayer", relayerPolicy, admin, relayerSigner);
console.log(`  relayer policy       ${relayer.policy.id}`);
console.log(`  relayer wallet       ${relayer.wallet.id}  ${relayer.wallet.address}`);

const values = {
  RELAYER_MODE: "privy",
  PRIVY_ADMIN_QUORUM_ID: admin.id,
  PRIVY_RELAYER_WALLET_ID: relayer.wallet.id,
  PRIVY_RELAYER_ADDRESS: relayer.wallet.address,
  PRIVY_RELAYER_AUTH_KEY: relayerSigner.privateKey,
  PRIVY_RELAYER_POLICY_ID: relayer.policy.id,
};

if (withRegistry) {
  const registrySigner = await quorum("polaris-registry-admin");
  const registry = await lockedWallet("polaris-registry-admin", registryPolicy, admin, registrySigner);
  console.log(`  registry admin       ${registry.wallet.id}  ${registry.wallet.address} (policy ${registry.policy.id})`);
  Object.assign(values, {
    REGISTRY_ACTIVATOR: "privy",
    PRIVY_REGISTRY_WALLET_ID: registry.wallet.id,
    PRIVY_REGISTRY_ADDRESS: registry.wallet.address,
    PRIVY_REGISTRY_AUTH_KEY: registrySigner.privateKey,
  });
}

const path = writeEnvPrivy(values);
banner("Done");
console.log(`Server settings written to ${path} (relayer key ${mask(relayerSigner.privateKey)}).`);
if (adminKeyFile) {
  console.log(`\nADMIN KEY: written once to ${adminKeyFile} (readable by you only; not printed here).`);
  console.log("It is the only key that can change these policies or wallets, and the server never needs it:");
  console.log("move it offline (a password manager), then delete the file.\n");
}
console.log("Next:");
console.log(`  1. Send the relayer testnet MON for gas: ${relayer.wallet.address} (about 1 MON covers ~300 relayed payments).`);
console.log(`  2. Give it its contract roles (PolarisPayments and MerchantRegistry operator, BatchSettlement settler):`);
console.log(`       RELAYER_ADDRESS=${relayer.wallet.address} pnpm --filter @polarispay/contracts grant-relayer:monad`);
if (withRegistry) {
  console.log(`  3. Make the registry admin own MerchantRegistry (run once, with the deployer key):`);
  console.log(`       NEW_OWNER=${values.PRIVY_REGISTRY_ADDRESS} node apps/business/scripts/transfer-registry-owner.mjs`);
}
console.log("  Then prove the policy denies what it should: pnpm --filter @polaris/business privy:prove-policy -- --run");
