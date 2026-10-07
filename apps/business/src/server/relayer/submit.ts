import "server-only";

import { decodeFunctionData, getAddress, type Address, type Hex, type TransactionReceipt } from "viem";

import { wrapInMemo, type CallMemo } from "../chain/circle";
import { buyerErrorFromThrown, type BuyerError } from "../chain/errors";
import { publicClient, requireChain } from "../chain/client";
import { getConfig, type ChainConfig } from "../env";
import { CONTRACT_ABIS, checkRelayerCall, PolicyViolation, type RelayerAddresses } from "../policy/relayer";
import type { RelayerAccount } from "./signer";

/**
 * Carry one call to the chain: policy check, simulation, gas, nonce, sign,
 * broadcast, receipt.
 *
 * - The call is checked against the relayer policy first (the same list the
 *   Privy policy is built from), so nothing off-list is ever signed.
 * - It is simulated with `eth_call` from the relayer's address. A revert
 *   comes back as the contract's own error, mapped to a message for the
 *   buyer, and no gas is spent.
 * - On Arc a checkout call goes through Arc's Memo contract with the order's
 *   reference (`memo`), so the payment carries it on chain; the relayer stays
 *   msg.sender of the inner call. Where Memo isn't deployed (a local node), or
 *   the wrapped call won't simulate, the call goes direct.
 * - The gas limit is `eth_estimateGas` + 15%, and the fee is priced at or
 *   above Arc's 20 gwei floor. Gas is USDC: the relayer holds nothing else.
 * - Nonces are assigned under a per-signer lock, from the larger of our own
 *   count and the node's pending count, so concurrent requests never collide.
 */

export class RelayRejected extends Error {
  readonly error: BuyerError;
  constructor(error: BuyerError) {
    super(error.message);
    this.name = "RelayRejected";
    this.error = error;
  }
}

export class RelayUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RelayUnavailable";
    this.code = code;
  }
}

export type SubmitResult = { txHash: Hex; receipt: TransactionReceipt | null; gasLimit: bigint; nonce: number; memo: CallMemo | null };

/** Arc's mempool floor for maxFeePerGas (20 gwei of native USDC). */
export const ARC_MIN_FEE_WEI = 20_000_000_000n;

export function relayerAddresses(chain: ChainConfig): RelayerAddresses {
  const c = chain.contracts;
  return {
    checkout: c.checkout,
    payments: c.payments,
    send: c.send,
    sendEurc: c.sendEurc,
    split: c.split,
    loanEngine: c.loanEngine,
    registry: c.registry,
    stablecoin: c.stablecoin,
    vault: c.vault,
    messageTransmitter: chain.circle?.messageTransmitterV2 ?? null,
    gatewayMinter: chain.circle?.gatewayMinter ?? null,
    memo: chain.circle?.memo ?? null,
  };
}

/** The registry admin may only activate and cap merchants. */
function checkActivatorCall(to: Address, data: Hex, chain: ChainConfig): void {
  if (getAddress(to) !== chain.contracts.registry) throw new PolicyViolation("to", "The registry admin only calls MerchantRegistry.");
  let fn: string;
  try {
    fn = decodeFunctionData({ abi: CONTRACT_ABIS.registry, data }).functionName;
  } catch {
    throw new PolicyViolation("function_name", "That isn't a MerchantRegistry function.");
  }
  if (fn !== "setActive" && fn !== "setMaxOrderValue") {
    throw new PolicyViolation("function_name", `MerchantRegistry.${fn} isn't on the registry admin's allow-list.`);
  }
}

const HEADROOM_BPS = 1_500n;
export const withHeadroom = (estimate: bigint) => (estimate * (10_000n + HEADROOM_BPS)) / 10_000n;

/* ── Nonces ─────────────────────────────────────────────────────────────── */

type Lane = { tail: Promise<unknown>; next: number | null };
// On globalThis: Next builds route handlers and the background workers as
// separate bundles, and both send as the relayer, so they must share lanes.
const g = globalThis as typeof globalThis & { __polarisNonceLanes?: Map<string, Lane> };
const lanes: Map<string, Lane> = (g.__polarisNonceLanes ??= new Map<string, Lane>());

function lane(address: Address): Lane {
  const key = address.toLowerCase();
  let l = lanes.get(key);
  if (!l) {
    l = { tail: Promise.resolve(), next: null };
    lanes.set(key, l);
  }
  return l;
}

/** Run `fn` after every earlier call for this signer has finished. */
function serialize<T>(address: Address, fn: (l: Lane) => Promise<T>): Promise<T> {
  const l = lane(address);
  const run = l.tail.then(() => fn(l));
  l.tail = run.catch(() => undefined);
  return run;
}

export function resetNoncesForTests(): void {
  lanes.clear();
}

/**
 * Forget what we think this signer's next nonce is, so the next send asks
 * the node. Called when one of its transactions was dropped: the nonce it
 * held is free again, and counting past it would leave a gap nothing fills.
 */
export function resetNonceLane(address: Address): void {
  const l = lanes.get(address.toLowerCase());
  if (l) l.next = null;
}

function isNonceError(error: unknown): boolean {
  const text = String((error as { details?: string; message?: string })?.details ?? (error as Error)?.message ?? error).toLowerCase();
  return text.includes("nonce too low") || text.includes("already known") || text.includes("nonce has already been used") || text.includes("replacement transaction underpriced");
}

/* ── Submit ─────────────────────────────────────────────────────────────── */

export async function submitCall(input: {
  signer: RelayerAccount;
  role: "relayer" | "activator";
  to: Address;
  data: Hex;
  /** How long to wait for the receipt; 0 returns right after broadcast. */
  waitMs: number;
  /** Attach this memo through Arc's Memo contract, where it is deployed. */
  memo?: CallMemo | null;
}): Promise<SubmitResult> {
  const chain = requireChain();
  const client = publicClient();
  const { signer } = input;
  let to = input.to;
  let data = input.data;

  const limits = getConfig().relayerLimits;
  if (input.role === "relayer") {
    checkRelayerCall({ to, data, value: 0n, chainId: chain.id }, { chainId: chain.id, addresses: relayerAddresses(chain), minAmountUnits: limits.minTransferUnits });
  } else checkActivatorCall(to, data, chain);

  try {
    await client.call({ account: signer.address, to, data });
  } catch (error) {
    const buyer = buyerErrorFromThrown(error);
    if (buyer.revert) throw new RelayRejected(buyer);
    throw new RelayUnavailable("rpc_unavailable", "We couldn't reach the network. Nothing was charged; try again.", { cause: error });
  }

  // The memo: only once the plain call is known to succeed, and only where
  // the wrapped call simulates too (the policy was checked on the inner call).
  let memo: CallMemo | null = null;
  const memoContract = chain.circle?.memo ?? null;
  if (input.memo && memoContract && input.role === "relayer") {
    const wrapped = wrapInMemo(to, data, input.memo);
    try {
      await client.call({ account: signer.address, to: memoContract, data: wrapped });
      to = memoContract;
      data = wrapped;
      memo = input.memo;
    } catch (error) {
      console.warn(`[relay] Memo wrap didn't simulate; sending the call direct: ${(error as Error).message?.split("\n")[0]}`);
    }
  }

  let gasLimit: bigint;
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    const [estimate, estimatedFees] = await Promise.all([
      client.estimateGas({ account: signer.address, to, data }),
      client.estimateFeesPerGas({ chain: undefined, type: "eip1559" }),
    ]);
    gasLimit = withHeadroom(estimate);
    const floor = chain.local ? 0n : ARC_MIN_FEE_WEI;
    fees = {
      maxFeePerGas: estimatedFees.maxFeePerGas > floor ? estimatedFees.maxFeePerGas : floor,
      maxPriorityFeePerGas: estimatedFees.maxPriorityFeePerGas,
    };
  } catch (error) {
    const buyer = buyerErrorFromThrown(error);
    if (buyer.revert) throw new RelayRejected(buyer);
    throw new RelayUnavailable("rpc_unavailable", "We couldn't reach the network. Nothing was charged; try again.", { cause: error });
  }
  // Caps on what one call may cost the relayer, in gas and in fee.
  if (gasLimit > limits.maxGas) {
    throw new PolicyViolation("RELAYER_MAX_GAS", `This call needs ${gasLimit} gas; the relayer pays for at most ${limits.maxGas}.`);
  }
  if (fees.maxFeePerGas > limits.maxFeePerGasWei) {
    throw new RelayUnavailable("network_busy", "The network is unusually expensive right now. Nothing was charged; try again in a few minutes.");
  }

  const { txHash, nonce } = await serialize(signer.address, async (l) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = await client.getTransactionCount({ address: signer.address, blockTag: "pending" });
      const nonce = l.next === null || attempt > 0 ? pending : Math.max(l.next, pending);
      let raw: Hex;
      try {
        if (!signer.account.signTransaction) throw new Error("This signer can't sign transactions.");
        raw = await signer.account.signTransaction({
          type: "eip1559",
          chainId: chain.id,
          to,
          data,
          nonce,
          gas: gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
      } catch (error) {
        // Privy's policy engine refusing is the one failure that must never be retried.
        throw new RelayUnavailable("signer_refused", "The relayer refused to sign this. Nothing was charged.", { cause: error });
      }
      try {
        const hash = await client.sendRawTransaction({ serializedTransaction: raw });
        l.next = nonce + 1;
        return { txHash: hash, nonce };
      } catch (error) {
        if (attempt === 0 && isNonceError(error)) {
          l.next = null;
          continue;
        }
        const buyer = buyerErrorFromThrown(error);
        if (buyer.revert) throw new RelayRejected(buyer);
        throw new RelayUnavailable("broadcast_failed", "The network didn't accept this. Nothing was charged; try again.", { cause: error });
      }
    }
    throw new RelayUnavailable("broadcast_failed", "The network didn't accept this. Nothing was charged; try again.");
  });

  let receipt: TransactionReceipt | null = null;
  if (input.waitMs > 0) {
    try {
      receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: input.waitMs, pollingInterval: 250 });
    } catch {
      receipt = null; // still pending: the caller reports "submitted" and the chain sync finishes the job
    }
  }
  return { txHash, receipt, gasLimit, nonce, memo };
}
