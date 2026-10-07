#!/usr/bin/env node
// Create the payout signer for automatic daily payouts (docs/research/privy.md §6).
//
//   pnpm --filter @polaris/business privy:setup-payouts            # dry run: explains and shows an example policy
//   pnpm --filter @polaris/business privy:setup-payouts -- --apply # creates the signer in your Privy app
//
// The payout signer is one Privy key quorum whose P-256 private key the
// server keeps (PRIVY_PAYOUT_SIGNER_KEY). A merchant who turns on automatic
// payouts adds it to their own embedded wallet from the dashboard
// (`useSigners().addSigners`), with a policy the server creates for them
// (src/server/policy/payout.ts) that lets it sign one thing: an AUSD
// TransferWithAuthorization on this chain, from their wallet, to the payout
// address they chose, up to $10,000 per payout. The relayer submits it, so the
// merchant never holds MON. Turning payouts off removes the signer.

import { banner, flag, loadDeployment, loadEnv, mask, privyClient, writeEnvPrivy } from "./lib.mjs";
import { buildPayoutPolicy } from "../../src/server/policy/payout.ts";

const env = loadEnv();
const deployment = loadDeployment(env);

banner("Automatic payouts: the payout signer");
console.log("Each merchant who turns payouts on gets their own policy, like this one (payout address 0x5555…5555):");
console.log(
  JSON.stringify(
    buildPayoutPolicy({
      merchantKey: "did:privy:example",
      payoutAddress: "0x5555555555555555555555555555555555555555",
      stablecoin: deployment.addresses.stablecoin,
      chainId: deployment.chainId,
    }),
    null,
    2,
  ),
);

if (!flag("apply")) {
  console.log("\nDry run: nothing was created. Re-run with --apply to create the payout signer in your Privy app.");
  process.exit(0);
}

const privy = await privyClient(env);
const { generateP256KeyPair } = await import("@privy-io/node");
const { privateKey, publicKey } = await generateP256KeyPair();
const quorum = await privy.keyQuorums().create({ public_keys: [publicKey], authorization_threshold: 1, display_name: "polaris-payout-signer" });

const path = writeEnvPrivy({
  PRIVY_PAYOUT_SIGNER_ID: quorum.id,
  NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID: quorum.id,
  PRIVY_PAYOUT_SIGNER_KEY: privateKey,
});
banner("Done");
console.log(`  payout signer key quorum  ${quorum.id}`);
console.log(`  settings written to ${path} (key ${mask(privateKey)})`);
console.log("\nNext: restart the dashboard. Merchants can now turn on automatic payouts under Payouts;");
console.log("the server sweeps daily at their chosen hour, or now with POST /api/payouts/automatic/run.");
