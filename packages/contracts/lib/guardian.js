/**
 * Owner operations on the deployed GuardianReceiver, for scripts/guardian.js
 * (`guardian:monad`, `guardian:local`) and its test. Reading needs no key;
 * changing anything is the receiver owner's (the deployer's) transaction.
 *
 *   status      the credit guard as PolarisCheckout.openPlan sees it
 *   thresholds  setThresholds from GUARD_* (lib/cre.js defaults for any unset).
 *               Decision 28's demo: GUARD_MIN_PRICE=1.001 makes the real AUSD
 *               price read as a depeg; caption it "threshold raised for demo",
 *               and set it back with GUARD_MIN_PRICE unset. It applies at
 *               once: the receiver judges the latest attestation's price by
 *               today's thresholds.
 *   override    setOverride(GUARD_OVERRIDE = none | resume | pause); a resume
 *               lasts GUARD_RESUME_SECONDS (default 3600, at most a day)
 *   acknowledge acknowledgeBadDebt(): only bad debt beyond today's counts
 *   max-age     setMaxAttestationAge(GUARD_MAX_ATTESTATION_AGE_SECONDS)
 */

"use strict";

const tx = require("./tx");
const { GUARDIAN_DEFAULTS, GUARDIAN_OVERRIDE, GUARDIAN_REASON, guardianThresholds } = require("./cre");

const OVERRIDE_NAMES = { none: GUARDIAN_OVERRIDE.NONE, resume: GUARDIAN_OVERRIDE.FORCE_RESUME, pause: GUARDIAN_OVERRIDE.FORCE_PAUSE };

/** Reason bits as words, e.g. 5 -> ["depeg", "bad debt"]. */
function reasonWords(mask) {
  const m = Number(mask);
  const words = [];
  if (m & GUARDIAN_REASON.DEPEG) words.push("depeg");
  if (m & GUARDIAN_REASON.LOW_CASH) words.push("low pool cash");
  if (m & GUARDIAN_REASON.BAD_DEBT) words.push("bad debt");
  if (m & GUARDIAN_REASON.STALE_PRICE) words.push("stale price");
  if (m & GUARDIAN_REASON.OWNER_PAUSE) words.push("paused by the owner");
  return words;
}

/** The guard in one plain object (bigints as strings). */
async function guardianStatus(guardian) {
  const s = await guardian.creditStatus();
  const t = await guardian.thresholds();
  const a = await guardian.latestAttestation();
  const [roundId, answer] = await guardian.latestRoundData();
  return {
    guardian: await guardian.getAddress(),
    paused: s.paused,
    reasons: Number(s.reasons),
    reasonWords: reasonWords(s.reasons),
    /** Low cash and bad debt, read from the pool now. */
    poolReasons: Number(s.poolReasons),
    /** Depeg and stale price, from the latest attestation under today's thresholds (0 once stale). */
    priceReasons: Number(s.priceReasons),
    stale: s.stale,
    override: Object.keys(OVERRIDE_NAMES).find((k) => OVERRIDE_NAMES[k] === Number(s.overrideMode)),
    overrideUntil: Number(s.overrideUntil),
    badDebtAcknowledged: s.badDebtAcknowledged.toString(),
    maxAttestationAge: Number(s.maxAttestationAge),
    thresholds: {
      minPrice: t.minPrice.toString(),
      maxPrice: t.maxPrice.toString(),
      minFreeCash: t.minFreeCash.toString(),
      maxBadDebtBps: Number(t.maxBadDebtBps),
      minOriginated: t.minOriginated.toString(),
      maxPriceAge: Number(t.maxPriceAge),
    },
    latest:
      s.observedAt === 0n
        ? null
        : {
            observedAt: Number(a.observedAt),
            creditPaused: a.creditPaused,
            reasons: Number(a.reasons),
            price: a.price.toString(),
            priceRoundId: a.priceRoundId.toString(),
            priceUpdatedAt: Number(a.priceUpdatedAt),
            freeCash: a.freeCash.toString(),
            totalOwed: a.totalOwed.toString(),
            badDebt: a.badDebt.toString(),
            totalOriginated: a.totalOriginated.toString(),
          },
    feed: { round: roundId.toString(), answer: answer.toString(), description: await guardian.description() },
  };
}

/** Longest forced resume GuardianReceiver takes (MAX_FORCE_RESUME), and the default one. */
const MAX_RESUME_SECONDS = 24 * 3600;
const DEFAULT_RESUME_SECONDS = 3600;

/**
 * Run one action against `guardian` (connected to its owner for changes).
 * `config` is scripts/deploy-monad.js guardianConfig(env) for "thresholds" and
 * "max-age"; `override` the GUARD_OVERRIDE word for "override", and
 * `resumeSeconds` how long a "resume" lasts.
 */
async function runGuardianAction(guardian, action, { config, override, resumeSeconds = DEFAULT_RESUME_SECONDS } = {}) {
  switch (action) {
    case "status":
      return { sent: null };
    case "thresholds": {
      const r = await tx.send(guardian, "setThresholds", [guardianThresholds(config?.guardianThresholds ?? GUARDIAN_DEFAULTS)]);
      return { sent: r.hash };
    }
    case "override": {
      if (!(override in OVERRIDE_NAMES)) throw new Error('GUARD_OVERRIDE must be "none", "resume" or "pause"');
      let until = 0n;
      if (override === "resume") {
        const seconds = Number(resumeSeconds);
        if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_RESUME_SECONDS) {
          throw new Error(`GUARD_RESUME_SECONDS must be 1 to ${MAX_RESUME_SECONDS}: a forced resume always ends`);
        }
        const block = await guardian.runner.provider.getBlock("latest");
        until = BigInt(block.timestamp + seconds);
      }
      const r = await tx.send(guardian, "setOverride", [OVERRIDE_NAMES[override], until]);
      return { sent: r.hash };
    }
    case "acknowledge": {
      const r = await tx.send(guardian, "acknowledgeBadDebt", []);
      return { sent: r.hash };
    }
    case "max-age": {
      const age = config?.maxAttestationAge;
      if (!age) throw new Error("Set GUARD_MAX_ATTESTATION_AGE_SECONDS");
      const r = await tx.send(guardian, "setMaxAttestationAge", [age]);
      return { sent: r.hash };
    }
    default:
      throw new Error(`Unknown GUARD_ACTION "${action}": status, thresholds, override, acknowledge or max-age`);
  }
}

module.exports = { OVERRIDE_NAMES, MAX_RESUME_SECONDS, reasonWords, guardianStatus, runGuardianAction };
