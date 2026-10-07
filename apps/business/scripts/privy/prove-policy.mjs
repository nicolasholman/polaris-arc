#!/usr/bin/env node
// Prove the relayer's Privy policy does what it says: ask Privy to SIGN (never
// send) the allowed calls and the forbidden ones, and print what Privy did.
// This is the Privy bounty's evidence: a compromised server holding the
// relayer's key still can't get Privy to sign anything off the list.
//
//   pnpm --filter @polaris/business privy:prove-policy            # shows the requests, calls nothing
//   pnpm --filter @polaris/business privy:prove-policy -- --run   # asks Privy to sign each (no transaction is broadcast)
//
// Needs the relayer from setup-relayer.mjs (PRIVY_RELAYER_WALLET_ID, _ADDRESS, _AUTH_KEY).

import { encodeFunctionData, erc20Abi, zeroHash } from "viem";

import { collateralVaultAbi, iausdAbi, polarisCheckoutAbi } from "@polarispay/contracts/abi";
import { banner, flag, loadDeployment, loadEnv, privyClient } from "./lib.mjs";

const env = loadEnv();
const deployment = loadDeployment(env);
const { addresses, chainId, vaultWithdraw } = deployment;
const buyer = "0x1111111111111111111111111111111111111111";
const merchant = "0x2222222222222222222222222222222222222222";

const payData = encodeFunctionData({
  abi: polarisCheckoutAbi,
  functionName: "pay",
  args: [buyer, merchant, 25_000_000n, "policy-proof", 0n, 4_000_000_000n, 27, zeroHash, zeroHash],
});

const minAmountUnits = BigInt(env.RELAYER_MIN_TRANSFER_UNITS ?? "100000");
const transferData = (value) =>
  encodeFunctionData({
    abi: iausdAbi,
    functionName: "transferWithAuthorization",
    args: [buyer, merchant, value, 0n, 4_000_000_000n, zeroHash, 27, zeroHash, zeroHash],
  });

const cases = [
  { expect: "allowed", what: "PolarisCheckout.pay (on the list)", tx: { to: addresses.checkout, data: payData } },
  { expect: "allowed", what: `AUSD transferWithAuthorization of ${minAmountUnits} base units (the minimum)`, tx: { to: addresses.stablecoin, data: transferData(minAmountUnits) } },
  { expect: "denied", what: "AUSD transferWithAuthorization of 0 (free gas for strangers)", tx: { to: addresses.stablecoin, data: transferData(0n) } },
  { expect: "denied", what: "the same call carrying 1 wei of MON", tx: { to: addresses.checkout, data: payData, value: "0x1" } },
  { expect: "denied", what: "the same call to another contract", tx: { to: buyer, data: payData } },
  {
    expect: "denied",
    what: "AUSD approve(attacker, max)",
    tx: { to: addresses.stablecoin, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [buyer, 2n ** 256n - 1n] }) },
  },
  { expect: "denied", what: "a plain MON transfer", tx: { to: buyer, value: "0x2386f26fc10000" } },
];
if (addresses.vault) {
  const lock = (amount) =>
    encodeFunctionData({ abi: collateralVaultAbi, functionName: "lockWithPermit", args: [buyer, amount, 4_000_000_000n, 27, zeroHash, zeroHash] });
  cases.splice(
    2,
    0,
    { expect: "allowed", what: `CollateralVault.lockWithPermit of ${minAmountUnits} base units (a secured line, no MON)`, tx: { to: addresses.vault, data: lock(minAmountUnits) } },
    { expect: "denied", what: "CollateralVault.lockWithPermit of 0", tx: { to: addresses.vault, data: lock(0n) } },
    {
      expect: "denied",
      what: "CollateralVault.seize (the loan engine's call, not the relayer's)",
      tx: { to: addresses.vault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: "seize", args: [buyer, 1n, merchant] }) },
    },
  );
}

// Take out of Boost: only where the vault has withdrawWithSig (a vault redeployed for it; not Monad testnet's
// today), so a proof against today's testnet policy isn't asked about a call its vault can't take.
if (addresses.vault && vaultWithdraw) {
  const take = (amount) => encodeFunctionData({ abi: collateralVaultAbi, functionName: "withdrawWithSig", args: [buyer, amount, 4_000_000_000n, "0x"] });
  cases.splice(
    2,
    0,
    { expect: "allowed", what: `CollateralVault.withdrawWithSig of ${minAmountUnits} base units (take out of Boost, no MON)`, tx: { to: addresses.vault, data: take(minAmountUnits) } },
    { expect: "denied", what: "CollateralVault.withdrawWithSig of 0", tx: { to: addresses.vault, data: take(0n) } },
    {
      expect: "denied",
      what: "CollateralVault.withdraw (pays its caller: the relayer)",
      tx: { to: addresses.vault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: "withdraw", args: [minAmountUnits] }) },
    },
  );
}

banner(`Relayer policy proof on chain ${chainId}`);
for (const c of cases) console.log(`  expect ${c.expect.padEnd(8)} ${c.what}`);
if (!flag("run")) {
  console.log("\nNothing was sent. Re-run with --run to ask Privy to sign each (nothing is broadcast).");
  process.exit(0);
}
const walletId = env.PRIVY_RELAYER_WALLET_ID;
const key = env.PRIVY_RELAYER_AUTH_KEY;
if (!walletId || !key) throw new Error("Run scripts/privy/setup-relayer.mjs --apply first (PRIVY_RELAYER_WALLET_ID, PRIVY_RELAYER_AUTH_KEY).");

const privy = await privyClient(env);
let failures = 0;
for (const c of cases) {
  let got;
  let detail = "";
  try {
    await privy.wallets().ethereum().signTransaction(walletId, {
      params: { transaction: { ...c.tx, chain_id: chainId, nonce: 0, gas_limit: "0x30d40", max_fee_per_gas: "0x174876e800", max_priority_fee_per_gas: "0x3b9aca00", type: 2 } },
      authorization_context: { authorization_private_keys: [key] },
    });
    got = "allowed";
  } catch (error) {
    got = "denied";
    detail = error?.message ?? String(error);
  }
  const ok = got === c.expect;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${got.padEnd(8)} ${c.what}${detail ? `  (${detail.slice(0, 120)})` : ""}`);
}
console.log(failures ? `\n${failures} case(s) did not behave as expected.` : "\nThe policy allows the listed call and denies the rest.");
process.exitCode = failures ? 1 : 0;
