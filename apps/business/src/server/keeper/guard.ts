import "server-only";

import { getAddress, zeroAddress, type Address } from "viem";

import {
  GUARD_PAUSED_MESSAGE,
  fixed,
  guardChecks,
  pegCheck,
  reasonsFromMask,
  type CreditGuard,
  type CreditGuardState,
  type GuardOverride,
  type GuardThresholds,
} from "@/lib/data/guard";

import { creditGuardAbi, polarisCheckoutAbi } from "../chain/abis";
import { publicClient, requireChain } from "../chain/client";
import type { ChainConfig } from "../env";

/**
 * The credit guard, read from the chain.
 *
 * `PolarisCheckout.creditPaused()` is what `openPlan` applies, so it is the
 * one answer to "can a buyer open Pay in 4 now"; CreditGuard's
 * `creditStatus()` says why: the pool as it reads it, the thresholds, the
 * override and until when, and the bad debt the owner acknowledged. One read
 * per 10 s per process, shared by every caller: the app polls it, the hosted
 * checkout, the shop and the dashboard.
 *
 * It fails open the way the contract does: no guard, or a read that fails,
 * never reports Pay in 4 as paused. And it never reports open what the
 * checkout refuses: when PolarisCheckout asks another guard than the one
 * configured here, its own answer still decides `paused`.
 */

const TTL_MS = 10_000;

type RawPool = { freeCash: bigint; totalOwed: bigint; badDebt: bigint; totalOriginated: bigint };

type RawStatus = {
  paused: boolean;
  reasons: number;
  poolReasons: number;
  overrideMode: number;
  overrideUntil: bigint;
  badDebtAcknowledged: bigint;
  pool: RawPool;
  thresholds: { minFreeCash: bigint; maxBadDebtBps: number; minOriginated: bigint };
  /** The USDC / USD peg check (zeros without a feed). */
  priceReasons: number;
  priceFeed: Address;
  price: bigint;
  priceUpdatedAt: bigint;
  minPrice: bigint;
  maxPriceAge: number;
};

/** Everything one read returns, before it is put in words. */
export type GuardReads = {
  /** PolarisCheckout.creditGuardian(): the guard openPlan asks (zero when none). */
  checkoutGuardian: Address;
  /** PolarisCheckout.creditPaused(): what openPlan applies. */
  gate: { paused: boolean; reasons: number };
  status: RawStatus;
};

/** What the checkout's own gate says when this API can't read the guard it asks. */
export type GateOnly = Pick<GuardReads, "checkoutGuardian" | "gate">;

const OVERRIDES: GuardOverride[] = ["none", "resume", "pause"];

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

/** Put one read in words. Pure: tested without a chain. */
export function describeGuard(reads: GuardReads | GateOnly | null, chain: Pick<ChainConfig, "contracts">, readAt: Date): CreditGuard {
  const guardian = chain.contracts.guardian;
  const empty: CreditGuard = {
    state: "unconfigured",
    paused: false,
    reasons: [],
    message: null,
    ageSeconds: null,
    override: "none",
    overrideUntil: null,
    guardian,
    mismatch: null,
    readAt: readAt.toISOString(),
    thresholds: null,
    pool: null,
    checks: [],
    price: null,
  };
  if (!guardian) return empty;
  if (!reads) return { ...empty, state: "unavailable" };
  if (reads.checkoutGuardian === zeroAddress) return empty;
  if (getAddress(reads.checkoutGuardian) !== getAddress(guardian)) {
    // The checkout asks another guard (a redeploy this API's env hasn't
    // caught up with). Its own gate still decides: never offer Pay in 4 that
    // the relay would then refuse with credit_paused.
    const paused = reads.gate.paused;
    return {
      ...empty,
      state: paused ? "paused" : "unconfigured",
      paused,
      reasons: paused ? reasonsFromMask(reads.gate.reasons) : [],
      message: paused ? GUARD_PAUSED_MESSAGE : null,
      mismatch: { checkoutGuardian: getAddress(reads.checkoutGuardian), configuredGuardian: getAddress(guardian) },
    };
  }
  if (!("status" in reads)) return { ...empty, state: "unavailable" };

  const s = reads.status;
  const paused = reads.gate.paused;
  const override = OVERRIDES[s.overrideMode] ?? "none";
  const state: CreditGuardState = paused ? "paused" : "open";
  const t: GuardThresholds = { minFreeCash: s.thresholds.minFreeCash, maxBadDebtBps: Number(s.thresholds.maxBadDebtBps), minOriginated: s.thresholds.minOriginated };
  const p = s.pool;
  // Older guards (no peg check) return no price fields.
  const hasFeed = Boolean(s.priceFeed) && s.priceFeed !== zeroAddress;
  return {
    ...empty,
    state,
    paused,
    reasons: reasonsFromMask(paused ? reads.gate.reasons : 0),
    message: paused ? GUARD_PAUSED_MESSAGE : null,
    override,
    overrideUntil: override === "resume" && s.overrideUntil > 0n ? iso(s.overrideUntil) : null,
    thresholds: { minFreeCashUnits: t.minFreeCash.toString(), maxBadDebtBps: t.maxBadDebtBps, minOriginatedUnits: t.minOriginated.toString() },
    pool: {
      freeCashUnits: p.freeCash.toString(),
      totalOwedUnits: p.totalOwed.toString(),
      badDebtUnits: p.badDebt.toString(),
      totalOriginatedUnits: p.totalOriginated.toString(),
      badDebtAcknowledgedUnits: s.badDebtAcknowledged.toString(),
    },
    checks: hasFeed ? [...guardChecks(p, t, s.badDebtAcknowledged), pegCheck({ ...s, maxPriceAge: Number(s.maxPriceAge), priceReasons: Number(s.priceReasons) }, readAt)] : guardChecks(p, t, s.badDebtAcknowledged),
    price: hasFeed
      ? {
          feed: getAddress(s.priceFeed),
          usd: fixed(s.price, 8, 2),
          updatedAt: s.priceUpdatedAt > 0n ? iso(s.priceUpdatedAt) : null,
          minUsd: fixed(s.minPrice, 8, 2),
          maxAgeSeconds: Number(s.maxPriceAge),
        }
      : null,
  };
}

let warnedMismatch: string | null = null;

/** Read the guard from the chain. Null when there is no guard. */
async function readGuard(chain: ChainConfig): Promise<GuardReads | GateOnly | null> {
  const guardian = chain.contracts.guardian;
  if (!guardian) return null;
  const client = publicClient();
  const [checkoutGuardian, gate] = await Promise.all([
    client.readContract({ address: chain.contracts.checkout, abi: polarisCheckoutAbi, functionName: "creditGuardian" }) as Promise<Address>,
    client.readContract({ address: chain.contracts.checkout, abi: polarisCheckoutAbi, functionName: "creditPaused" }) as Promise<readonly [boolean, number]>,
  ]);
  const gateOnly: GateOnly = { checkoutGuardian, gate: { paused: Boolean(gate[0]), reasons: Number(gate[1]) } };
  if (checkoutGuardian === zeroAddress) return gateOnly;
  if (getAddress(checkoutGuardian) !== getAddress(guardian)) {
    const key = `${checkoutGuardian}:${guardian}`;
    if (warnedMismatch !== key) {
      warnedMismatch = key;
      console.warn(
        `[guard] PolarisCheckout asks CreditGuard ${checkoutGuardian}, but this API is configured with ${guardian}: ` +
          "serving the checkout's own gate only. Update the deployment record the API reads.",
      );
    }
    return gateOnly;
  }
  const status = (await client.readContract({ address: guardian, abi: creditGuardAbi, functionName: "creditStatus" })) as unknown as RawStatus;
  return { ...gateOnly, status };
}

let cache: { key: string; at: number; value: Promise<CreditGuard> } | null = null;

/** Tests: forget the last read. */
export function resetCreditGuardForTests(): void {
  cache = null;
  warnedMismatch = null;
}

/**
 * The credit guard now, read at most once per 10 s per process. A failed
 * read is `unavailable` (not paused), and isn't cached past the next call.
 */
export async function creditGuard(options: { fresh?: boolean } = {}): Promise<CreditGuard> {
  const chain = requireChain();
  const key = `${chain.id}:${chain.contracts.guardian ?? "none"}`;
  if (!options.fresh && cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;
  const at = Date.now();
  const value = readGuard(chain)
    .then((reads) => describeGuard(reads, chain, new Date(at)))
    .catch((error: unknown) => {
      console.error("[guard] couldn't read the credit guard", error instanceof Error ? error.message : error);
      if (cache?.value === value) cache = null;
      return describeGuard(null, chain, new Date(at));
    });
  cache = { key, at, value };
  return value;
}
