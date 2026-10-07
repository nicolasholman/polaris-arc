#!/usr/bin/env node
// Send testnet MON for gas from the deployer to the project's own server wallets
// (the Privy relayer and the registry admin). Monad testnet only.
//
//   node apps/business/scripts/privy/fund-testnet.mjs <address> <MON> [<address> <MON> ...]           # shows what it would send
//   node apps/business/scripts/privy/fund-testnet.mjs <address> <MON> [<address> <MON> ...] --apply   # sends it
//
// Reads DEPLOYER_PRIVATE_KEY from the git-ignored repo-root .env; never prints it.

import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { REPO_DIR, flag, parseEnvFile } from "./lib.mjs";

const RPC = process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz";
const MAX_EACH = parseEther("2");

const pairs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (pairs.length === 0 || pairs.length % 2 !== 0) throw new Error("usage: fund-testnet.mjs <address> <MON> [<address> <MON> ...] [--apply]");
const sends = [];
for (let i = 0; i < pairs.length; i += 2) {
  const value = parseEther(pairs[i + 1]);
  if (value <= 0n || value > MAX_EACH) throw new Error(`${pairs[i + 1]} MON: send between 0 and ${formatEther(MAX_EACH)} MON at a time`);
  sends.push({ to: getAddress(pairs[i]), value });
}

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createPublicClient({ chain, transport: http(RPC) });
if ((await client.getChainId()) !== 10143) throw new Error(`${RPC} is not Monad testnet: this script only sends testnet MON.`);
const env = { ...parseEnvFile(`${REPO_DIR}/.env`), ...process.env };
if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY in the repo-root .env.");
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`);
console.log(`From the deployer ${account.address}: ${formatEther(await client.getBalance({ address: account.address }))} MON`);
for (const s of sends) console.log(`  ${formatEther(s.value)} MON to ${s.to} (holds ${formatEther(await client.getBalance({ address: s.to }))})`);
if (!flag("apply")) {
  console.log("\nNothing sent. Re-run with --apply.");
  process.exit(0);
}
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
for (const s of sends) {
  const hash = await wallet.sendTransaction({ to: s.to, value: s.value, gas: 21_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`sent ${formatEther(s.value)} MON to ${s.to}: ${receipt.status}, block ${receipt.blockNumber}, ${hash}`);
  console.log(`  it holds ${formatEther(await client.getBalance({ address: s.to }))} MON`);
}
console.log(`The deployer holds ${formatEther(await client.getBalance({ address: account.address }))} MON.`);
