/**
 * A tiny chain for handler tests: it hands out blocks, timestamps, log
 * indexes and transaction hashes, so a test reads like the transactions it
 * simulates, and runs them through Envio's real test indexer.
 */

import { createTestIndexer, type TestIndexer } from "envio";

import { settingsFor } from "../src/deployment.js";

export const CHAIN = 10143 as const;
export const SETTINGS = settingsFor(CHAIN);
export const A = SETTINGS.addresses;

/** Deterministic, lowercase test accounts. */
export function account(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

export const RELAYER = account(0x7e1a);
export const TRANSMITTER = account(0xc2e);
export const USD = (n: number) => BigInt(Math.round(n * 1e6));

type TxOpts = { from?: string; to?: string; dt?: number };
type AnyItem = Record<string, unknown>;

export class Sim {
  readonly indexer: TestIndexer = createTestIndexer();
  block: number;
  time: number;
  private logIndex = 0;
  private hash = "0x";
  private txFrom: string = RELAYER;
  private txTo: string | undefined;
  private items: AnyItem[] = [];
  private txCount = 0;

  constructor(start = 1_790_000_000) {
    this.block = Math.max(SETTINGS.startBlock, 1);
    this.time = start;
  }

  /** Start a transaction in the next block, `dt` seconds later (default 1). */
  tx(opts: TxOpts = {}): this {
    this.block += 1;
    this.time += opts.dt ?? 1;
    this.logIndex = 0;
    this.txCount += 1;
    this.hash = `0x${this.txCount.toString(16).padStart(64, "0")}`;
    this.txFrom = opts.from ?? RELAYER;
    this.txTo = opts.to;
    return this;
  }

  /** Move the clock without a transaction. */
  wait(seconds: number): this {
    this.time += seconds;
    return this;
  }

  get txHash(): string {
    return this.hash;
  }

  /** Emit a log in the current transaction. */
  log(contract: string, event: string, params: Record<string, unknown>, srcAddress?: string): this {
    this.items.push({
      contract,
      event,
      params,
      ...(srcAddress ? { srcAddress } : {}),
      logIndex: this.logIndex++,
      block: { number: this.block, timestamp: this.time },
      transaction: { hash: this.hash, from: this.txFrom, to: this.txTo },
    });
    return this;
  }

  /** A stablecoin Transfer (MerchantWallet is wildcard: the token is the emitter). */
  transfer(from: string, to: string, value: bigint, token: string = A.Stablecoin): this {
    return this.log("MerchantWallet", "Transfer", { from, to, value }, token);
  }

  /**
   * A business registering with the MerchantRegistry, in its own transaction.
   * Only from then on are its stablecoin transfers fetched (and so may be
   * simulated): the test indexer drops any other as the source would.
   */
  registerMerchant(merchant: string, name = "Studio Sur", payoutAddress: string = merchant): this {
    return this.tx({ from: RELAYER, to: A.MerchantRegistry }).log("MerchantRegistry", "MerchantRegistered", { merchant, name, payoutAddress });
  }

  /** Run everything emitted since the last run through the indexer. */
  async run(): Promise<void> {
    const simulate = this.items;
    this.items = [];
    await this.indexer.process({ chains: { [CHAIN]: { simulate } } } as never);
  }
}
