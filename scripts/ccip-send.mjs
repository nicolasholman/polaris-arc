#!/usr/bin/env node
/**
 * Pay a Polaris order on Arc from another chain, over CCTP V2 + Chainlink
 * CCIP. USER-RUN: it signs and broadcasts on the source chain with your key.
 * Testnet only: it refuses every mainnet source.
 *
 *   PAYER_PRIVATE_KEY=0x… node scripts/ccip-send.mjs pay \
 *     --from base-sepolia --merchant 0x… --order <orderId> --amount 1.00 [--refund-to 0x…]
 *   node scripts/ccip-send.mjs status --message 0x…        # the intent on Arc + the CCIP Explorer link
 *   node scripts/ccip-send.mjs finish --from base-sepolia --tx 0x… [--api http://localhost:3100]
 *       # once Circle has attested the burn: Polaris mints the USDC on Arc (POST /api/public/cctp/mint)
 *
 * What happens: PolarisCCIPSender (deployments/arc-testnet.json ccip.senders)
 * takes your USDC, burns it with CCTP V2 to PolarisCCIPReceiver on Arc, and
 * sends the order with CCIP (fee in the source chain's native coin). On Arc the
 * receiver records the intent when the CCIP message lands and pays the order
 * when the CCTP mint lands, in either order.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const req = createRequire(join(REPO, "apps", "business", "package.json"));
const viem = await import(req.resolve("viem"));
const { privateKeyToAccount } = await import(req.resolve("viem/accounts"));
const chains = await import(req.resolve("viem/chains"));
const { networkFor } = createRequire(join(REPO, "packages", "contracts", "package.json"))("./lib/networks.js");

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const network = networkFor("testnet");
const record = JSON.parse(readFileSync(opt("record", join(REPO, "packages", "contracts", "deployments", "arc-testnet.json")), "utf8"));
const SOURCES = { "base-sepolia": 84532, "ethereum-sepolia": 11155111 };
const VIEM_CHAINS = { 84532: chains.baseSepolia, 11155111: chains.sepolia };

const senderAbi = JSON.parse(readFileSync(join(REPO, "packages", "contracts", "abi", "PolarisCCIPSender.json"), "utf8"));
const receiverAbi = JSON.parse(readFileSync(join(REPO, "packages", "contracts", "abi", "PolarisCCIPReceiver.json"), "utf8"));
const erc20 = viem.parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);

function source(name) {
  const chainId = SOURCES[name];
  if (!chainId) throw new Error(`--from must be one of ${Object.keys(SOURCES).join(", ")} (testnet only; mainnet sources are never sent from here)`);
  const s = network.ccip.sources.find((x) => x.chainId === chainId);
  const sender = record.ccip?.senders?.[chainId]?.address;
  if (!sender) throw new Error(`No PolarisCCIPSender recorded for ${s.name}: run packages/contracts scripts/ccip-deploy-sender.js first.`);
  return { ...s, sender, chain: VIEM_CHAINS[chainId] };
}

async function pay() {
  const key = process.env.PAYER_PRIVATE_KEY;
  if (!key) throw new Error("Set PAYER_PRIVATE_KEY (a testnet key holding the source chain's USDC and a little gas).");
  const s = source(opt("from"));
  const account = privateKeyToAccount(key);
  const merchant = viem.getAddress(opt("merchant"));
  const orderId = opt("order");
  const amount = viem.parseUnits(opt("amount"), 6);
  const refundTo = viem.getAddress(opt("refund-to", account.address));
  if (!orderId) throw new Error("--order is required");
  const pub = viem.createPublicClient({ chain: s.chain, transport: viem.http(s.rpcUrl) });
  const wallet = viem.createWalletClient({ account, chain: s.chain, transport: viem.http(s.rpcUrl) });

  const held = await pub.readContract({ address: s.usdc, abi: erc20, functionName: "balanceOf", args: [account.address] });
  if (held < amount) throw new Error(`${account.address} holds ${viem.formatUnits(held, 6)} USDC on ${s.name}: faucet.circle.com`);
  const fee = await pub.readContract({ address: s.sender, abi: senderAbi, functionName: "quotePay", args: [merchant, amount, orderId, refundTo], account: account.address });
  console.log(`Paying ${viem.formatUnits(amount, 6)} USDC from ${s.name} to order "${orderId}" at ${merchant} on Arc (CCIP fee ${viem.formatEther(fee)} native)`);
  const allowance = await pub.readContract({ address: s.usdc, abi: erc20, functionName: "allowance", args: [account.address, s.sender] });
  if (allowance < amount) {
    const h = await wallet.writeContract({ address: s.usdc, abi: erc20, functionName: "approve", args: [s.sender, amount] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  approve ${h}`);
  }
  const hash = await wallet.writeContract({ address: s.sender, abi: senderAbi, functionName: "payOnArc", args: [merchant, amount, orderId, refundTo], value: (fee * 11n) / 10n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const [sent] = viem.parseEventLogs({ abi: senderAbi, logs: receipt.logs, eventName: "PaySent" });
  console.log(`  payOnArc ${hash}`);
  console.log(`  CCIP message ${sent.args.messageId}: ${network.ccip.explorer}/msg/${sent.args.messageId}`);
  console.log(`\nNext: when Circle has attested the burn (minutes on testnet), finish the mint on Arc:\n  node scripts/ccip-send.mjs finish --from ${opt("from")} --tx ${hash}\nand check the intent:\n  node scripts/ccip-send.mjs status --message ${sent.args.messageId}`);
}

async function status() {
  const id = opt("message");
  const pub = viem.createPublicClient({ transport: viem.http(record.rpcUrl ?? network.rpcUrl) });
  const [kind, st, amount, selector, sender] = await pub.readContract({ address: record.contracts.PolarisCCIPReceiver.address, abi: receiverAbi, functionName: "intentOf", args: [id] });
  const names = ["not arrived on Arc yet", "pending (waiting for the CCTP mint)", "settled", "refunded on Arc", "failed (stored for retry)"];
  console.log(`Intent ${id}\n  status: ${names[st] ?? st}\n  kind: ${kind === 1 ? "pay" : kind === 2 ? "repay" : "-"}\n  amount: ${viem.formatUnits(amount, 6)} USDC\n  from: ${selector} ${sender}\n  CCIP Explorer: ${network.ccip.explorer}/msg/${id}`);
}

async function finish() {
  const s = source(opt("from"));
  const api = opt("api", "http://localhost:3100");
  const res = await fetch(`${api}/api/public/cctp/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDomain: s.cctpDomain, txHash: opt("tx") }) });
  console.log(JSON.stringify(await res.json(), null, 2));
}

const run = { pay, status, finish }[cmd];
if (!run) {
  console.error("usage: ccip-send.mjs pay|status|finish …  (see the header)");
  process.exit(2);
}
run().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
