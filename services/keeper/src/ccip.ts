/**
 * Cross-chain payments (Chainlink CCIP + Circle CCTP V2): finish what arrived.
 *
 * A buyer on Base or Ethereum pays a Polaris order through PolarisCCIPSender:
 * CCTP burns their USDC and mints it on Arc to PolarisCCIPReceiver, and CCIP
 * carries the order there. The two land independently. When CCIP lands first
 * the receiver records the intent as pending, and nothing on chain wakes it
 * when the mint lands later: `settle(messageId)` is permissionless, and this
 * is the keeper calling it.
 *
 * Each run: new IntentReceived logs since the last run (2,000-block pages,
 * under Arc's eth_getLogs limit), then every intent still pending is
 * simulated and, if the USDC is there, settled. Settling never needs the
 * keeper's role: any key works, and gas is a few cents of USDC.
 */

import { polarisCCIPReceiverAbi } from "@polarispay/contracts/abi";
import type { Address, Hex } from "viem";

import { type Clients, fees } from "./chain.ts";
import type { KeeperConfig } from "./config.ts";

export const INTENT_STATUS = { NONE: 0, PENDING: 1, SETTLED: 2, REFUNDED: 3, FAILED: 4 } as const;
const PAGE = 2_000n;

export type CcipRun = { scannedTo: bigint; pending: number; settled: Array<{ messageId: Hex; hash: Hex }>; waiting: Array<{ messageId: Hex; reason: string }> };

/** The intents worth trying: still pending, oldest first (the receiver settles in arrival order of funds). */
export function pendingIds(seen: ReadonlyMap<Hex, number>): Hex[] {
  return [...seen.entries()].filter(([, status]) => status === INTENT_STATUS.PENDING).map(([id]) => id);
}

export class CcipSettler {
  private readonly seen = new Map<Hex, number>();
  private cursor: bigint | null = null;
  private readonly c: Clients;
  private readonly config: KeeperConfig;
  private readonly receiver: Address;
  private readonly fromBlock: bigint;

  constructor(c: Clients, config: KeeperConfig, receiver: Address, fromBlock: bigint) {
    this.c = c;
    this.config = config;
    this.receiver = receiver;
    this.fromBlock = fromBlock;
  }

  async run(): Promise<CcipRun> {
    const head = await this.c.public.getBlockNumber();
    let from = this.cursor === null ? this.fromBlock : this.cursor + 1n;
    while (from <= head) {
      const to = from + PAGE - 1n < head ? from + PAGE - 1n : head;
      const logs = await this.c.public.getContractEvents({ address: this.receiver, abi: polarisCCIPReceiverAbi, eventName: "IntentReceived", fromBlock: from, toBlock: to });
      for (const l of logs) if (l.args.messageId) this.seen.set(l.args.messageId, INTENT_STATUS.PENDING);
      from = to + 1n;
    }
    this.cursor = head;

    const out: CcipRun = { scannedTo: head, pending: 0, settled: [], waiting: [] };
    for (const id of pendingIds(this.seen)) {
      const [, status] = await this.c.public.readContract({ address: this.receiver, abi: polarisCCIPReceiverAbi, functionName: "intentOf", args: [id] });
      this.seen.set(id, Number(status));
      if (Number(status) !== INTENT_STATUS.PENDING) continue;
      out.pending++;
      if (!this.c.wallet || !this.c.account) {
        out.waiting.push({ messageId: id, reason: "read-only keeper" });
        continue;
      }
      try {
        // Simulate first: a NotFunded revert costs nothing and means "the mint isn't here yet".
        const call = { address: this.receiver, abi: polarisCCIPReceiverAbi, functionName: "settle", args: [id], account: this.c.account } as const;
        await this.c.public.simulateContract(call);
        const gas = ((await this.c.public.estimateContractGas(call)) * 12n) / 10n;
        const hash = await this.c.wallet.writeContract({ ...call, chain: this.c.chain, gas, ...(await fees(this.c.public, this.config.chainId)) });
        const receipt = await this.c.public.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status === "success") {
          this.seen.set(id, INTENT_STATUS.SETTLED);
          out.settled.push({ messageId: id, hash });
          out.pending--;
        } else out.waiting.push({ messageId: id, reason: `reverted ${hash}` });
      } catch (e) {
        // NotFunded: the CCTP mint hasn't landed yet (Circle's attestation, then the relayer's receiveMessage).
        const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
        out.waiting.push({ messageId: id, reason: msg.includes("NotFunded") ? "waiting for the CCTP mint" : (msg.split("\n")[0] ?? msg) });
      }
    }
    return out;
  }
}
