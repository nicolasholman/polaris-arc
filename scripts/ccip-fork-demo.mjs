#!/usr/bin/env node
/**
 * Rehearse a cross-chain payment on an Arc testnet FORK (scripts/arc-fork.sh):
 * the CCIP message and the CCTP mint land in the WRONG order, and the keeper
 * finishes the payment, against the PolarisCCIPReceiver the deploy script put
 * on the fork beside Chainlink's real Arc testnet router.
 *
 *   node scripts/ccip-fork-demo.mjs        # then: the keeper's --once run settles it
 *
 * What is real and what stands in (fork only, never on a live network):
 *  - Chainlink's Arc testnet router is real; the delivery is the router's own
 *    call (`ccipReceive` from the router address, impersonated: a fork has no
 *    off-ramp/DON to deliver a message sent on Base Sepolia).
 *  - The CCTP mint is stood in for by crediting the receiver's native balance
 *    (on Arc the native balance IS the USDC ERC-20 at 0x3600…0000); a real
 *    mint needs Circle's attestation of a burn on the source chain.
 *  - The allowlisted source sender is a placeholder address (the real one is
 *    PolarisCCIPSender on Base Sepolia once deployed by the user).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const req = createRequire(join(REPO, "apps", "business", "package.json"));
const viem = await import(req.resolve("viem"));
const RPC = process.env.ARC_FORK_RPC_URL || "http://127.0.0.1:18745";
const record = JSON.parse(readFileSync(process.env.E2E_RECORD || join(REPO, ".fork", "arc-fork.json"), "utf8"));
const abi = JSON.parse(readFileSync(join(REPO, "packages", "contracts", "abi", "PolarisCCIPReceiver.json"), "utf8"));
const erc20 = viem.parseAbi(["function balanceOf(address) view returns (uint256)"]);

if (process.argv[2] === "check") {
  const c = viem.createPublicClient({ transport: viem.http(RPC) });
  const id = process.argv[3];
  const [, status, amt] = await c.readContract({ address: record.contracts.PolarisCCIPReceiver.address, abi, functionName: "intentOf", args: [id] });
  const logs = await c.getContractEvents({ address: record.contracts.PolarisCCIPReceiver.address, abi, eventName: "CrossChainPayment", args: { messageId: id }, fromBlock: BigInt(record.contracts.PolarisCCIPReceiver.blockNumber ?? 0) });
  console.log(`intent ${id}: ${["none", "pending", "settled", "refunded", "failed"][status]}, ${viem.formatUnits(amt, 6)} USDC`);
  for (const l of logs) console.log(`  CrossChainPayment to ${l.args.merchant} order "${l.args.orderId}" paymentId ${l.args.paymentId} (tx ${l.transactionHash})`);
  process.exit(status === 2 ? 0 : 1);
}

const client = viem.createTestClient({ mode: "anvil", transport: viem.http(RPC) }).extend(viem.publicActions).extend(viem.walletActions);
const chainId = await client.getChainId();
if (chainId !== 5042002) throw new Error(`Expected an Arc testnet fork (5042002), got ${chainId}.`);
await client.request({ method: "anvil_nodeInfo" }).catch(() => {
  throw new Error(`${RPC} isn't an anvil fork: this demo impersonates accounts and only runs on scripts/arc-fork.sh.`);
});

const receiver = record.contracts.PolarisCCIPReceiver.address;
const router = record.ccip.router;
const owner = record.roles.owner;
const merchant = record.demo.merchant;
const usdc = record.contracts.USDC.address;
const BASE_SEPOLIA = BigInt(record.ccip.sources.find((s) => s.chainId === 84532).selector);
const SENDER_ON_BASE = viem.getAddress("0x00000000000000000000000000000000000cc1b5");
const amount = 2_500_000n;
const orderId = `ccip-fork-${Date.now()}`;

const as = async (who, fn) => {
  await client.impersonateAccount({ address: who });
  await client.setBalance({ address: who, value: viem.parseEther("10") });
  try {
    const hash = await fn(who);
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`reverted: ${hash}`);
    return r;
  } finally {
    await client.stopImpersonatingAccount({ address: who });
  }
};

console.log(`Arc testnet fork ${RPC}: PolarisCCIPReceiver ${receiver}, Chainlink router ${router}`);
await as(owner, (a) => client.writeContract({ account: a, address: receiver, abi, functionName: "allowSender", args: [BASE_SEPOLIA, SENDER_ON_BASE, true], chain: null }));
console.log(`1. owner allowlisted (Base Sepolia ${BASE_SEPOLIA}, ${SENDER_ON_BASE})`);

const payIntent = viem.encodeAbiParameters(
  [{ type: "tuple", components: [{ name: "sourcePayer", type: "address" }, { name: "arcRefundTo", type: "address" }, { name: "merchant", type: "address" }, { name: "orderId", type: "string" }, { name: "amount", type: "uint256" }] }],
  [{ sourcePayer: viem.getAddress("0x00000000000000000000000000000000000b0bb0"), arcRefundTo: viem.getAddress("0x00000000000000000000000000000000000b0bb0"), merchant, orderId, amount }],
);
const data = viem.encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [1, payIntent]);
const messageId = viem.keccak256(viem.toHex(orderId));
const msg = { messageId, sourceChainSelector: BASE_SEPOLIA, sender: viem.encodeAbiParameters([{ type: "address" }], [SENDER_ON_BASE]), data, destTokenAmounts: [] };

const before = await client.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [receiver] });
await as(router, (a) => client.writeContract({ account: a, address: receiver, abi, functionName: "ccipReceive", args: [msg], chain: null, gas: 600_000n }));
let [, status] = await client.readContract({ address: receiver, abi, functionName: "intentOf", args: [messageId] });
console.log(`2. CCIP message ${messageId} delivered by the router before the dollars: status ${["none", "pending", "settled", "refunded", "failed"][status]}`);

const native = await client.getBalance({ address: receiver });
await client.setBalance({ address: receiver, value: native + amount * 10n ** 12n });
const after = await client.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [receiver] });
console.log(`3. stand-in for the CCTP mint: receiver USDC ${viem.formatUnits(before, 6)} -> ${viem.formatUnits(after, 6)}`);
console.log(`\nNow the keeper settles it (it scans IntentReceived and calls settle):\n  KEEPER_RPC_URL=${RPC} POLARIS_DEPLOYMENT_FILE=.fork/arc-fork.json pnpm --filter @polaris/keeper once`);
console.log(`Check: node scripts/ccip-fork-demo.mjs check ${messageId}`);
