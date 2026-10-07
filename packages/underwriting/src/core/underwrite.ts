/**
 * The one function the CRE `underwrite` workflow and the Node service both
 * call: evidence in; Facts, the on-chain report, the score and the product
 * decision out.
 *
 * Pure and deterministic. It reads no clock (the caller passes DON time as
 * `observedAt`), no network and no environment, and uses nothing outside
 * ECMAScript, so it compiles to WASM with the workflow.
 *
 *   const out = underwrite({ user, observedAt, account, linked, linkVerified });
 *   if (!out.final) throw new Error(`not final: ${out.missing.join(", ")}`); // no report, the app retries
 *   if (!out.attest) return { status: "thin" };                             // too thin to attest: no report, no retry
 *   runtime.report(prepareReportRequest(out.report));                       // UnderwritingReceiver's batch, one item
 */

import { encodeUnderwritingReport } from "./abi.ts";
import { attestGaps } from "./attest.ts";
import { FACTS_VERSION, MODEL_VERSION } from "./constants.ts";
import { decide } from "./decision.ts";
import { deriveFacts, type Derivation, type DeriveOptions } from "./facts.ts";
import { declineReasonFor, explainFacts } from "./reasons.ts";
import { scoreBreakdown, type ScoreBreakdown } from "./score.ts";
import type { Address, CreditDecision, Facts, Hex, SubjectEvidence } from "./types.ts";

export interface UnderwriteInput {
  /** The buyer's Polaris account: the address ScoreManager scores. */
  user: Address;
  /** Unix seconds. In CRE, `runtime.now()`; never the node's own clock. */
  observedAt: number | bigint;
  account: SubjectEvidence;
  linked?: SubjectEvidence | null;
  /**
   * The linked wallet's ownership signature was checked (see link.ts). A
   * linked wallet without it can be previewed but never reported.
   */
  linkVerified?: boolean;
  /** What the buyer owes on open plans, for what is available now. */
  activeDebt?: bigint;
  /** A purchase to quote, in 6-decimal base units. */
  purchase?: bigint | null;
  options?: DeriveOptions;
}

export interface UnderwriteOutcome {
  version: { facts: number; model: number };
  user: Address;
  /** Every fact the report depends on was read (and a linked wallet's ownership proven). */
  final: boolean;
  /**
   * The DON may attest this: final, and the facts pass the thin-file gate
   * (attest.ts). Exactly when `report` is set. A final outcome that does not
   * attest is a thin file: send nothing, and do not retry until the account
   * has more history; `decision.thinFile` says what is short.
   */
  attest: boolean;
  /** `<role>.<field>` for everything that kept it from being final. */
  missing: string[];
  /**
   * `<role>.<field>` for evidence no configured provider could read (its key is
   * not set here): left out, earning no points (facts.ts). When an entry of
   * `missing` is here too (a risk check), asking again cannot help until the
   * key is set; `decision.headline` says reviews aren't set up.
   */
  absent: string[];
  /**
   * Nothing can be attested, and that is for want of provider keys rather
   * than of history or of a source that may answer later: not final only
   * because absent risk checks are, or a thin file whose history was absent.
   * The CRE workflow reports this as "unavailable", never as a thin file.
   */
  unavailable: boolean;
  facts: Facts;
  /**
   * The history wallet the report names, so the receiver can hold it to this
   * account: the linked wallet when one was given (used or excluded), null
   * for the account alone.
   */
  linkedWallet: Address | null;
  /**
   * The report UnderwritingReceiver decodes, with this one underwriting:
   * `abi.encode(uint8 2, [(user, linkedWallet, facts)])`. Null unless `attest`.
   */
  report: Hex | null;
  breakdown: ScoreBreakdown;
  decision: CreditDecision;
  derivation: Derivation;
}

export function underwrite(input: UnderwriteInput): UnderwriteOutcome {
  const derivation = deriveFacts({
    account: input.account,
    linked: input.linked ?? null,
    observedAt: input.observedAt,
    options: input.options,
  });

  const missing = [...derivation.missing];
  if (derivation.linked && input.linkVerified !== true) missing.push("linked.ownership");
  // Ownership is never waived, not even by allowPartial: an unproven wallet is someone else's history.
  const final = derivation.final && !missing.includes("linked.ownership");

  // A linked wallet that is the account itself links nothing (deriveFacts drops it too).
  const linkedWallet = derivation.linked ? (derivation.linked.address as Address) : null;

  // A risk check no configured provider can run (only those are both absent and missing) keeps it from
  // ever being final until the key is set: no retry will finish it, whatever else is still missing.
  const absent = derivation.absent;
  const waitsOnKeys = !final && missing.some((m) => absent.includes(m));

  // A report for an empty account opens ScoreManager's $200 floor unsecured: thin facts are never attested
  // (declines are). The same gate as the CRE workflow's; see attest.ts.
  const gaps = attestGaps(derivation.facts);
  const attest = final && gaps.length === 0;
  // A thin file whose age or activity no configured provider could read may not be thin at all.
  const thinForWantOfKeys = final && gaps.length > 0 && absent.some((a) => a.endsWith(".firstSeenAt") || a.endsWith(".sentCount"));
  const unavailable = (waitsOnKeys && !missing.includes("linked.ownership")) || thinForWantOfKeys;

  const breakdown = scoreBreakdown(derivation.facts);
  const reasons = explainFacts(derivation.facts, breakdown, derivation);
  const decision = decide({
    score: breakdown.score,
    declined: breakdown.declined,
    declineReason: declineReasonFor(breakdown),
    activeDebt: input.activeDebt,
    purchase: input.purchase ?? null,
    reasons,
    hasLinked: derivation.linked !== null,
    pending: final
      ? thinForWantOfKeys
        ? "unavailable"
        : null
      : missing.every((m) => m === "linked.ownership")
        ? "ownership"
        : waitsOnKeys
          ? "unavailable"
          : "checks",
    thinFile: gaps,
  });

  return {
    version: { facts: FACTS_VERSION, model: MODEL_VERSION },
    user: input.user,
    final,
    attest,
    missing,
    absent,
    unavailable,
    facts: derivation.facts,
    linkedWallet,
    report: attest ? encodeUnderwritingReport([{ user: input.user, linkedWallet, facts: derivation.facts }]) : null,
    breakdown,
    decision,
    derivation,
  };
}

/**
 * Explain facts that are already on chain (from an `Underwritten` event or a
 * report), without the evidence behind them: the reasons use neutral wording
 * where the source is unknown. The thin-file gate is not applied: these facts
 * were attested, and ScoreManager scored them as they are.
 */
export function explainOnChainFacts(
  facts: Facts,
  opts: { activeDebt?: bigint; purchase?: bigint | null; hasLinked?: boolean } = {},
): { breakdown: ScoreBreakdown; decision: CreditDecision } {
  const breakdown = scoreBreakdown(facts);
  // A linked account's history counted: say so (its age, balances across both), without naming its address.
  const reasons = explainFacts(facts, breakdown, opts.hasLinked ? { linked: { address: "", used: true, excludedFor: null, riskLabel: null } } : {});
  const decision = decide({
    score: breakdown.score,
    declined: breakdown.declined,
    declineReason: declineReasonFor(breakdown),
    activeDebt: opts.activeDebt,
    purchase: opts.purchase ?? null,
    reasons,
    hasLinked: opts.hasLinked ?? false,
  });
  return { breakdown, decision };
}
