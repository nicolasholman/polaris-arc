/**
 * Report encoding for the Polaris keeper's receivers: one report format per
 * receiver, the first word of each body its kind.
 *
 *   kind 1  collections  -> CollectionsReceiver.submitReport
 *           abi.encode(uint8 1, (uint8 action, uint256 id)[] tasks)
 *           action 1 collectInstallment(id), 2 chargeDue(id), 3 liquidate(id).
 *           The timed run and the instant retry (on
 *           PolarisCheckout.Reauthorized) both write it; the retry's tasks are
 *           `CollectionsReceiver.dueTasksFor(buyer)`.
 *   kind 2  underwriting -> UnderwritingReceiver.submitReport
 *           abi.encode(uint8 2, (address user, address linkedWallet, Facts facts)[] items)
 *
 * The keeper (services/keeper, TypeScript) builds the same bytes with viem's
 * encodeAbiParameters, and its tests hold them to these byte for byte. These
 * ethers helpers are what the contract tests use to build reports by hand.
 *
 * CreditGuard needs no report: it reads the pool live. GUARD_* below are its
 * reason bits and defaults, and `guardPoolReasons` is CreditGuard.poolReasons
 * in JavaScript, held to the contract by test/integration/CreditGuard.test.js.
 */

"use strict";

const { AbiCoder } = require("ethers");

const coder = AbiCoder.defaultAbiCoder();

/** The first word of each report body. */
const REPORT_KIND = { COLLECTIONS: 1, UNDERWRITING: 2 };

/** CollectionsReceiver task actions. */
const ACTION = { COLLECT_INSTALLMENT: 1, CHARGE_SUBSCRIPTION: 2, LIQUIDATE: 3 };

/** CreditGuard reason bits. */
const GUARD_REASON = { DEPEG: 1, LOW_CASH: 2, BAD_DEBT: 4, STALE_PRICE: 8, OWNER_PAUSE: 0x80 };

/** CreditGuard.Override. */
const GUARD_OVERRIDE = { NONE: 0, FORCE_RESUME: 1, FORCE_PAUSE: 2 };

/**
 * CreditGuard's default policy (USDC base units, 6 decimals): pause new plans
 * below $1,000 of free cash, or when unacknowledged bad debt passes 5% of
 * lifetime originations once $10,000 has been lent.
 */
const GUARD_DEFAULTS = {
  minFreeCash: 1_000_000_000n,
  maxBadDebtBps: 500,
  minOriginated: 10_000_000_000n,
};

/** A full Thresholds tuple from partial overrides. */
function guardThresholds(t = {}) {
  return {
    minFreeCash: BigInt(t.minFreeCash ?? GUARD_DEFAULTS.minFreeCash),
    maxBadDebtBps: Number(t.maxBadDebtBps ?? GUARD_DEFAULTS.maxBadDebtBps),
    minOriginated: BigInt(t.minOriginated ?? GUARD_DEFAULTS.minOriginated),
  };
}

/** CreditGuard.poolReasons in JavaScript. */
function guardPoolReasons(pool, thresholds = GUARD_DEFAULTS, badDebtAcknowledged = 0n) {
  const t = guardThresholds(thresholds);
  let reasons = 0;
  if (BigInt(pool.freeCash) < t.minFreeCash) reasons |= GUARD_REASON.LOW_CASH;
  const originated = BigInt(pool.totalOriginated);
  if (originated >= t.minOriginated) {
    const bad = BigInt(pool.badDebt);
    const ack = BigInt(badDebtAcknowledged);
    const unack = bad > ack ? bad - ack : 0n;
    if (unack > (originated * BigInt(t.maxBadDebtBps)) / 10_000n) reasons |= GUARD_REASON.BAD_DEBT;
  }
  return reasons;
}

const TASKS_TYPE = "tuple(uint8 action,uint256 id)[]";
const FACTS_TYPE =
  "tuple(uint32 walletAgeDays,uint32 txCount,uint64 stableBalance,uint32 defiTenureDays,uint16 priorLiquidations,uint16 relatedWallets,bool exchangeFunded,uint64 observedAt)";
const UNDERWRITINGS_TYPE = `tuple(address user,address linkedWallet,${FACTS_TYPE} facts)[]`;

/** abi.encode(uint8 1, (uint8 action, uint256 id)[]) for CollectionsReceiver. */
function encodeCollectionsReport(tasks) {
  return coder.encode(["uint8", TASKS_TYPE], [REPORT_KIND.COLLECTIONS, tasks.map((t) => [t.action, t.id])]);
}

/** abi.encode(uint8 2, (address user, address linkedWallet, Facts facts)[]) for UnderwritingReceiver. */
function encodeUnderwritingReport(items) {
  return coder.encode(
    ["uint8", UNDERWRITINGS_TYPE],
    [
      REPORT_KIND.UNDERWRITING,
      items.map((i) => [
        i.user,
        i.linkedWallet ?? "0x0000000000000000000000000000000000000000",
        [
          i.facts.walletAgeDays,
          i.facts.txCount,
          i.facts.stableBalance,
          i.facts.defiTenureDays,
          i.facts.priorLiquidations,
          i.facts.relatedWallets,
          i.facts.exchangeFunded,
          i.facts.observedAt,
        ],
      ]),
    ]
  );
}

/** Decode a collections report body: { kind, tasks: [{ action, id }] } (numbers as bigint, action as number). */
function decodeCollectionsReport(body) {
  const [kind, tasks] = coder.decode(["uint8", TASKS_TYPE], body);
  return { kind: Number(kind), tasks: tasks.map((t) => ({ action: Number(t.action), id: t.id })) };
}

/** Decode an underwriting report body: { kind, items: [{ user, linkedWallet, facts }] }. */
function decodeUnderwritingReport(body) {
  const [kind, items] = coder.decode(["uint8", UNDERWRITINGS_TYPE], body);
  return {
    kind: Number(kind),
    items: items.map((i) => ({
      user: i.user,
      linkedWallet: i.linkedWallet,
      facts: {
        walletAgeDays: Number(i.facts.walletAgeDays),
        txCount: Number(i.facts.txCount),
        stableBalance: i.facts.stableBalance,
        defiTenureDays: Number(i.facts.defiTenureDays),
        priorLiquidations: Number(i.facts.priorLiquidations),
        relatedWallets: Number(i.facts.relatedWallets),
        exchangeFunded: i.facts.exchangeFunded,
        observedAt: i.facts.observedAt,
      },
    })),
  };
}

/** The kind of any Polaris report body (its first word). */
function reportKind(body) {
  return Number(coder.decode(["uint8"], body)[0]);
}

module.exports = {
  REPORT_KIND,
  ACTION,
  GUARD_REASON,
  GUARD_OVERRIDE,
  GUARD_DEFAULTS,
  guardThresholds,
  guardPoolReasons,
  TASKS_TYPE,
  FACTS_TYPE,
  UNDERWRITINGS_TYPE,
  encodeCollectionsReport,
  encodeUnderwritingReport,
  decodeCollectionsReport,
  decodeUnderwritingReport,
  reportKind,
};
