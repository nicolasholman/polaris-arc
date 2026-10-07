#!/usr/bin/env node
// Hand MerchantRegistry to the registry admin (the Privy wallet from
// `privy:setup-relayer -- --registry-admin`), whose policy lets it do only two
// things: activate a merchant, and cap them at MERCHANT_ACTIVATION_CAP_USD.
//
//   NEW_OWNER=0x… node apps/business/scripts/transfer-registry-owner.mjs          # shows what it would do
//   NEW_OWNER=0x… node apps/business/scripts/transfer-registry-owner.mjs --apply  # sends transferOwnership
//
// Run it once, with DEPLOYER_PRIVATE_KEY (the current owner) in the repo-root
// .env, AFTER grant-relayer:monad (setting the relayer as a registry operator
// needs the owner). Gas: estimate + 15%, as every Polaris sender.

import { readFileSync, writeFileSync } from "node:fs";

import { createPublicClient, createWalletClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { merchantRegistryAbi } from "@polarispay/contracts/abi";
import { REPO_DIR, flag, loadDeployment, loadEnv, parseEnvFile } from "./privy/lib.mjs";

const env = { ...parseEnvFile(`${REPO_DIR}/.env`), ...loadEnv() };
const deployment = loadDeployment(env);
const rpc = env.POLARIS_RPC_URL ?? (deployment.chainId === 10143 ? "https://testnet-rpc.monad.xyz" : "http://127.0.0.1:8545");
if (!env.NEW_OWNER) throw new Error("Set NEW_OWNER to the registry admin's address.");
const newOwner = getAddress(env.NEW_OWNER);

const chain = defineChain({ id: deployment.chainId, name: `chain ${deployment.chainId}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
const current = await client.readContract({ address: deployment.addresses.registry, abi: merchantRegistryAbi, functionName: "owner" });
console.log(`MerchantRegistry ${deployment.addresses.registry}\n  owner now   ${current}\n  new owner   ${newOwner}`);
if (getAddress(current) === newOwner) {
  console.log("Already done.");
  process.exit(0);
}
if (deployment.chainId === 143) throw new Error("Refusing Monad mainnet.");
if (!flag("apply")) {
  console.log("\nNothing sent. Re-run with --apply.");
  process.exit(0);
}
if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY (the current owner) in the repo-root .env.");
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`);
if (getAddress(account.address) !== getAddress(current)) throw new Error(`DEPLOYER_PRIVATE_KEY is ${account.address}, not the owner ${current}.`);
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const request = { address: deployment.addresses.registry, abi: merchantRegistryAbi, functionName: "transferOwnership", args: [newOwner], account };
const gas = ((await client.estimateContractGas(request)) * 115n) / 100n;
const hash = await wallet.writeContract({ ...request, gas });
const receipt = await client.waitForTransactionReceipt({ hash });
console.log(`transferOwnership: ${receipt.status} in block ${receipt.blockNumber} (${hash})`);
if (receipt.status !== "success") process.exit(1);
// The record names the registry's owner, so check:deployment reads the new one back.
const record = JSON.parse(readFileSync(deployment.file, "utf8"));
record.roles = { ...record.roles, registryAdmin: newOwner, registryAdminTx: hash };
writeFileSync(deployment.file, `${JSON.stringify(record, null, 2)}
`);
console.log(`Recorded roles.registryAdmin in ${deployment.file}`);
