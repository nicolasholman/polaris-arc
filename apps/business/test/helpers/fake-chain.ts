import {
  decodeFunctionData,
  getAddress,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
  RawContractError,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";

/**
 * A stand-in for viem's PublicClient, with just the calls the server makes.
 * It really parses the signed transactions the relayer sends (so the tests
 * see the gas limit, the nonce and the calldata that would hit the chain) and
 * lets each test decide what a call returns, reverts with, or emits.
 */

export type SentTx = { hash: Hex; to: Address; data: Hex; gas: bigint; nonce: number; chainId: number; value: bigint; functionName: string; args: readonly unknown[] };

export type LogSpec = { address: Address; abi: Abi; eventName: string; args: Record<string, unknown> };

export function makeLog(spec: LogSpec, meta: { txHash: Hex; logIndex: number; blockNumber: bigint }): Log {
  const event = spec.abi.find((x) => x.type === "event" && x.name === spec.eventName) as
    | { inputs: readonly { name: string; type: string; indexed?: boolean }[] }
    | undefined;
  if (!event) throw new Error(`no event ${spec.eventName}`);
  const topics = encodeEventTopics({ abi: spec.abi, eventName: spec.eventName, args: spec.args } as never) as Hex[];
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed) as never,
    event.inputs.filter((i) => !i.indexed).map((i) => spec.args[i.name]) as never,
  );
  return {
    address: spec.address,
    topics: topics as [Hex, ...Hex[]],
    data,
    logIndex: meta.logIndex,
    transactionHash: meta.txHash,
    transactionIndex: 0,
    blockNumber: meta.blockNumber,
    blockHash: `0x${"ab".repeat(32)}` as Hex,
    removed: false,
  } as Log;
}

export class FakeChain {
  blockNumber = 100n;
  timestamp = BigInt(Math.floor(Date.now() / 1000));
  sent: SentTx[] = [];
  receipts = new Map<string, TransactionReceipt>();
  /** Revert data for the next simulated call, by function name. */
  reverts = new Map<string, Hex>();
  reads: Record<string, (args: readonly unknown[]) => unknown> = {};
  /** Send the next transaction but never mine it: no receipt, and the node forgets it (a dropped transaction). */
  dropNext = false;
  /** Mine every transaction, but let waitForTransactionReceipt time out (the relay answers "submitted"). */
  slowReceipts = false;
  /** Transactions someone else sent (a report through the forwarder), by hash. */
  transactions = new Map<Hex, { input: Hex; to?: Address }>();
  /** Hashes the node no longer knows. */
  dropped = new Set<Hex>();
  /** The relayer's mined nonce count, when a test wants it apart from what was sent (a replaced transaction). */
  minedNonce: number | null = null;
  /** What eth_feeHistory would suggest. */
  fees = { maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  /** What a sent transaction emits. */
  onSend: (tx: SentTx, fn: { functionName: string; args: readonly unknown[] }) => LogSpec[] = () => [];
  abis: Abi[] = [];
  logs: Log[] = [];

  constructor(abis: Abi[]) {
    this.abis = abis;
  }

  /** What was relayed for someone, without the operator's price quotes (one per checkout session). */
  get relayed(): SentTx[] {
    return this.sent.filter((t) => t.functionName !== "quoteOrder");
  }

  /** The price quotes the relayer pinned, as (merchant, orderKey, amount). */
  get quotes(): Array<{ merchant: Address; orderKey: Hex; amount: bigint }> {
    return this.sent.filter((t) => t.functionName === "quoteOrder").map((t) => {
      const [merchant, orderKey, amount] = t.args as [Address, Hex, bigint];
      return { merchant, orderKey, amount };
    });
  }

  private decode(data: Hex): { functionName: string; args: readonly unknown[] } {
    for (const abi of this.abis) {
      try {
        const d = decodeFunctionData({ abi, data });
        return { functionName: d.functionName, args: (d.args ?? []) as readonly unknown[] };
      } catch {
        // next
      }
    }
    return { functionName: "unknown", args: [] };
  }

  client() {
    return {
      call: async ({ data }: { data: Hex }) => {
        const { functionName } = this.decode(data);
        const revert = this.reverts.get(functionName);
        if (revert) throw new RawContractError({ data: revert });
        return { data: "0x" };
      },
      estimateGas: async () => {
        return 200_000n;
      },
      estimateFeesPerGas: async () => {
        return this.fees;
      },
      getTransactionCount: async ({ blockTag }: { blockTag?: string } = {}) => {
        if (blockTag === "latest" && this.minedNonce !== null) return this.minedNonce;
        return this.sent.length;
      },
      getTransaction: async ({ hash }: { hash: Hex }) => {
        const known = this.transactions.get(hash);
        if (known) return { hash, ...known };
        const tx = this.sent.find((t) => t.hash === hash);
        if (!tx || this.dropped.has(hash)) throw new Error(`Transaction with hash "${hash}" could not be found.`);
        return tx;
      },
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        const tx = parseTransaction(serializedTransaction);
        const hash = keccak256(serializedTransaction);
        const fn = this.decode(tx.data as Hex);
        const sent: SentTx = {
          hash,
          to: getAddress(tx.to as Address),
          data: tx.data as Hex,
          gas: tx.gas as bigint,
          nonce: tx.nonce as number,
          chainId: tx.chainId as number,
          value: tx.value ?? 0n,
          functionName: fn.functionName,
          args: fn.args,
        };
        this.sent.push(sent);
        if (this.dropNext) {
          this.dropNext = false;
          this.dropped.add(hash);
          return hash;
        }
        this.blockNumber += 1n;
        const specs = this.onSend(sent, fn);
        const logs = specs.map((spec, i) => makeLog(spec, { txHash: hash, logIndex: i, blockNumber: this.blockNumber }));
        this.logs.push(...logs);
        this.receipts.set(hash, {
          transactionHash: hash,
          status: "success",
          blockNumber: this.blockNumber,
          logs,
        } as unknown as TransactionReceipt);
        return hash;
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (this.slowReceipts) throw new Error("timed out");
        const r = this.receipts.get(hash);
        if (!r) throw new Error("no receipt");
        return r;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const r = this.receipts.get(hash);
        if (!r) throw new Error("no receipt");
        return r;
      },
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        const fn = this.reads[functionName];
        if (!fn) throw new Error(`FakeChain: no read for ${functionName}`);
        return fn(args ?? []);
      },
      getBlock: async () => {
        return { timestamp: this.timestamp };
      },
      getBlockNumber: async () => {
        return this.blockNumber;
      },
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        return this.logs.filter((l) => (l.blockNumber as bigint) >= fromBlock && (l.blockNumber as bigint) <= toBlock);
      },
      /** eth_getLogs with an address and topic filter (a topic may be null, one value, or a list of alternatives). */
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        if (method !== "eth_getLogs") throw new Error(`FakeChain: no ${method}`);
        const [q] = params as [{ address?: Address; topics?: Array<Hex | Hex[] | null>; fromBlock: Hex; toBlock: Hex }];
        const same = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
        const matches = (want: Hex | Hex[] | null | undefined, got: Hex | undefined) =>
          want === null || want === undefined || (Array.isArray(want) ? want.some((w) => same(w, got)) : same(want, got));
        return this.logs.filter(
          (l) =>
            (l.blockNumber as bigint) >= BigInt(q.fromBlock) &&
            (l.blockNumber as bigint) <= BigInt(q.toBlock) &&
            (!q.address || same(l.address, q.address)) &&
            (q.topics ?? []).every((want, i) => matches(want, l.topics[i])),
        );
      },
    };
  }
}
