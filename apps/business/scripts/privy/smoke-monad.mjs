#!/usr/bin/env node
// The Privy relayer's end-to-end evidence on Monad testnet: one real Pay now,
// relayed by the policy-locked Privy server wallet (eth_signTransaction in
// Privy's enclave, broadcast by us), settled on chain, read back complete.
//
//   pnpm --filter @polaris/business privy:smoke                  # checks the setup, sends nothing
//   pnpm --filter @polaris/business privy:smoke -- --run         # creates a $0.50 checkout and pays it
//
// Needs (you provide them; this script creates nothing in Privy):
//   POLARIS_API          a running Polaris for Business with RELAYER_MODE=privy on chain 10143
//                        (default http://localhost:3100)
//   POLARIS_SECRET_KEY   a merchant's sk_test_ key on that server
//   BUYER_PRIVATE_KEY    a throwaway test buyer holding at least $0.50 of testnet AUSD and
//                        no MON (it never sends a transaction). Never a real wallet's key.
//
// Prints the session, the relayer's transaction and its explorer link: paste
// them into the README next to `privy:prove-policy -- --run` as the Privy
// bounty's evidence.

import { privateKeyToAccount } from "viem/accounts";

import { banner, flag, loadEnv } from "./lib.mjs";

const env = loadEnv();
const API = (env.POLARIS_API ?? "http://localhost:3100").replace(/\/+$/, "");
const run = flag("run");

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${JSON.stringify(body?.error ?? body)}`);
  return body.data;
}

banner("Polaris relayer on Monad testnet: Privy smoke test");
const health = await call("/api/health");
console.log(`  server      ${API}`);
console.log(`  chain       ${health.chain?.id ?? "none"} (${health.chain?.name ?? health.chainProblem})`);
console.log(`  relayer     ${health.relayer.mode} ${health.relayer.address ?? ""}`);
const problems = [];
if (health.chain?.id !== 10143) problems.push("the server isn't on Monad testnet (chain 10143)");
if (health.relayer.mode !== "privy") problems.push("the server's relayer isn't the Privy server wallet (RELAYER_MODE=privy)");
if (!env.POLARIS_SECRET_KEY?.startsWith("sk_")) problems.push("POLARIS_SECRET_KEY (a merchant's sk_test_ key) is not set");
if (!/^0x[0-9a-fA-F]{64}$/.test(env.BUYER_PRIVATE_KEY ?? "")) problems.push("BUYER_PRIVATE_KEY (a throwaway test buyer with testnet AUSD) is not set");
if (problems.length) {
  for (const p of problems) console.log(`  MISSING     ${p}`);
  process.exit(1);
}
const buyer = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
console.log(`  buyer       ${buyer.address} (signs only; holds no MON)`);
if (!run) {
  console.log("\nReady. Nothing was sent. Re-run with --run to create a $0.50 checkout and pay it through the Privy relayer.");
  process.exit(0);
}

const orderId = `privy-smoke-${Date.now()}`;
const session = await call("/api/v1/checkout/sessions", {
  method: "POST",
  headers: { authorization: `Bearer ${env.POLARIS_SECRET_KEY}`, "idempotency-key": orderId },
  body: JSON.stringify({ amount: "0.50", description: "Privy relayer smoke test", modes: ["now"], successUrl: "https://example.com/thanks", orderId }),
});
console.log(`\n  session     ${session.id}`);
const pub = await call(`/api/public/sessions/${session.id}`);
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
const signature = await buyer.signTypedData({
  domain: { ...pub.chain.stablecoinDomain, chainId: pub.chain.chainId, verifyingContract: pub.chain.contracts.stablecoin },
  types: {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "ReceiveWithAuthorization",
  message: { from: buyer.address, to: pub.chain.contracts.payments, value: BigInt(pub.chain.amountUnits), validAfter: 0n, validBefore, nonce: pub.chain.orderKey },
});
const paid = await call("/api/relay", {
  method: "POST",
  body: JSON.stringify({ type: "pay", sessionId: session.id, buyer: buyer.address, validAfter: "0", validBefore: String(validBefore), signature }),
});
console.log(`  relayed     ${paid.status} ${paid.txHash}`);
console.log(`  explorer    ${paid.explorerUrl ?? "(no explorer configured)"}`);
const read = await call(`/api/v1/checkout/sessions/${session.id}`, { headers: { authorization: `Bearer ${env.POLARIS_SECRET_KEY}` } });
console.log(`  session     ${read.status} / ${read.paymentStatus}`);
if (read.paymentStatus !== "paid" && paid.status !== "submitted") process.exitCode = 1;
console.log("\nEvidence: the transaction above was signed by the Privy server wallet under its policy and paid for by it; the buyer sent nothing.");
