#!/usr/bin/env node
// Read docs/demo/testnet/results.json back from Monad testnet, independently of
// the run that wrote it: every transaction's receipt (status 1), its sender
// (the Privy relayer, the Privy registry admin or the labelled harness), its
// target (the contract the row names, at the deployment's address), and that
// it carried no MON; then every user account's MON balance and nonce today.
//
//   pnpm --filter @polaris/business smoke:testnet:verify
//
// Reads the chain only; sends nothing and needs no key.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createPublicClient, defineChain, formatEther, getAddress, http } from "viem";

import { REPO_DIR } from "./privy/lib.mjs";

const RPC = process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz";

/** The problems with one step, given what the chain returned for it (empty when it checks out). */
export function checkStep(step, { tx, receipt }, { contracts, senders }) {
  const problems = [];
  if (!receipt) return [`${step.txHash}: no receipt`];
  if (receipt.status !== "success") problems.push(`${step.txHash}: status ${receipt.status}`);
  if (getAddress(tx.from) !== getAddress(step.from)) problems.push(`${step.txHash}: sent by ${tx.from}, results say ${step.from}`);
  if (!senders.has(getAddress(tx.from))) problems.push(`${step.txHash}: sent by ${tx.from}, which is none of the relayer, the registry admin or the harness`);
  const expected = contracts[step.contract];
  if (!expected) problems.push(`${step.txHash}: ${step.contract} is not in the deployment record`);
  else if (getAddress(tx.to) !== getAddress(expected)) problems.push(`${step.txHash}: sent to ${tx.to}, but ${step.contract} is ${expected}`);
  if (tx.value !== 0n) problems.push(`${step.txHash}: carried ${tx.value} wei of MON`);
  if (step.by !== "harness (deployer)" && step.signedBy === "harness") problems.push(`${step.txHash}: a harness step not sent by the harness`);
  return problems;
}

async function main() {
  const results = JSON.parse(readFileSync(join(REPO_DIR, "docs", "demo", "testnet", "results.json"), "utf8"));
  const record = JSON.parse(readFileSync(join(REPO_DIR, "packages", "contracts", "deployments", "monad-testnet.json"), "utf8"));
  if (Number(results.chainId) !== 10143 || Number(record.chainId) !== 10143) throw new Error("Not Monad testnet results.");
  const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = createPublicClient({ chain, transport: http(RPC) });
  if ((await client.getChainId()) !== 10143) throw new Error(`${RPC} is not Monad testnet.`);

  const contracts = Object.fromEntries(Object.entries(record.contracts).map(([k, v]) => [k, getAddress(v.address)]));
  const relayer = getAddress(results.relayer.address);
  const senders = new Set([relayer, getAddress(results.harness), ...(results.activator ? [getAddress(results.activator.address)] : [])]);
  let failures = 0;
  let relayed = 0;
  console.log(`Reading ${results.steps.length} transactions of the ${results.at} run back from Monad testnet\n`);
  for (const step of results.steps) {
    const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: step.txHash }), client.getTransaction({ hash: step.txHash })]);
    const problems = checkStep(step, { tx, receipt }, { contracts, senders });
    if (getAddress(tx.from) === relayer) relayed++;
    failures += problems.length;
    const from = getAddress(tx.from);
    const who = from === relayer ? "Privy relayer" : results.activator && from === getAddress(results.activator.address) ? "Privy registry admin" : from === getAddress(results.harness) ? "harness" : from;
    console.log(`  ${problems.length ? "FAIL" : "ok  "}  status ${receipt.status === "success" ? 1 : 0}  ${who.padEnd(20)} → ${step.contract.padEnd(17)} block ${receipt.blockNumber}  ${step.txHash}`);
    for (const p of problems) console.log(`        ${p}`);
  }
  console.log("");
  for (const u of results.users) {
    const [mon, nonce] = await Promise.all([client.getBalance({ address: u.address }), client.getTransactionCount({ address: u.address })]);
    const ok = mon === 0n && nonce === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${u.address}  ${formatEther(mon)} MON, nonce ${nonce}  ${u.role}`);
  }
  console.log(
    failures
      ? `\n${failures} problem(s).`
      : `\nAll ${results.steps.length} transactions landed (status 1), each sent to the contract it names; ${relayed} were sent by the Privy relayer ${relayer}. None of the ${results.users.length} users holds MON or has sent a transaction.`,
  );
  process.exitCode = failures ? 1 : 0;
}

if (process.argv[1] && /verify-testnet-results\.mjs$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error.shortMessage ?? error.message ?? error);
    process.exitCode = 1;
  });
}
