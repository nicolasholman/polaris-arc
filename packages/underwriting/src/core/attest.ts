/**
 * Whether the DON may attest a set of facts at all: the thin-file gate.
 *
 * ScoreManager opens every underwritten wallet at UNDERWRITE_FLOOR (520, the
 * $200 tier) and adds what the facts earn, and PolarisLoanEngine lends against
 * that line unsecured. So a report for an account with no history is a free
 * $200 line: one person could open many free accounts, underwrite each one,
 * and draw about $196 from every one, and liquidation would seize nothing.
 * The security review proved it on a Hardhat chain through
 * UnderwritingReceiver with requireUnderwriting on (all facts 0: score 520,
 * creditLimitOf $200). The sybil and one-link checks cover only a linked
 * history wallet, so they do not help an account that brings none.
 *
 * So the DON attests only facts that show a life elsewhere, exactly as
 * `ScoreManager.isThinFile` requires on chain: at least 90 days since the
 * oldest activity AND at least 10 transactions, counted across every subject
 * the derivation used (the account, plus a linked wallet that passed its risk
 * checks). Age is the signal a farmer cannot parallelise; the transaction
 * floor stops an old wallet that was funded once and never used from
 * standing in for a history. Dollars do not count: the same balance can be
 * walked through account after account inside the 15 minutes a report is
 * good for.
 *
 * A thin file gets no report at all (the chain would refuse it with
 * ThinFile). The account stays where `requireUnderwriting` puts every account
 * before its report, exactly as `ScoreManager._securedOnly` treats it: no
 * unsecured line, collateral at face value. Because underwriting runs once
 * per account, that also keeps the door open: the buyer comes back with a
 * history wallet (Bring your history) or once the account has a history of
 * its own.
 *
 * A declined file is attested even when it is thin: `declined` shuts the
 * unsecured line for good and spends the history wallet (it can never back
 * another account), which is the point of the sybil and liquidation checks.
 *
 * The CRE underwriting workflow's gate (workflows/src/underwriting/thin.ts)
 * is the same rule, so the app's preview never promises a line the DON will
 * not attest, or that the chain would refuse.
 */

import { ATTEST_MINIMUM } from "./constants.ts";
import { scoreBreakdown } from "./score.ts";
import type { AttestGap, Facts } from "./types.ts";

export type { AttestGap };

type GateFacts = Omit<Facts, "observedAt"> & { observedAt?: bigint };

/** True when the DON may attest these facts: declined, or at least 90 days and 10 transactions of history. */
export function isAttestable(facts: GateFacts): boolean {
  if (scoreBreakdown(facts).declined) return true;
  return facts.walletAgeDays >= ATTEST_MINIMUM.walletAgeDays && facts.txCount >= ATTEST_MINIMUM.txCount;
}

/**
 * Empty when the facts may be attested. Otherwise the facts are a thin file,
 * and each entry is a requirement still to meet: ALL of them clear the gate.
 */
export function attestGaps(facts: GateFacts): AttestGap[] {
  if (isAttestable(facts)) return [];
  const gaps: AttestGap[] = [];
  if (facts.walletAgeDays < ATTEST_MINIMUM.walletAgeDays) gaps.push({ fact: "walletAgeDays", have: facts.walletAgeDays, need: ATTEST_MINIMUM.walletAgeDays });
  if (facts.txCount < ATTEST_MINIMUM.txCount) gaps.push({ fact: "txCount", have: facts.txCount, need: ATTEST_MINIMUM.txCount });
  return gaps;
}
