import type { CreditGuard, GuardReason } from "./guard";
import { GUARD_REASON_TEXT, reasonsFromMask, unitsToUsd } from "./guard";
import type { IsoDate } from "./types";

/**
 * The dashboard's Automation page (`GET /api/automation`): the Polaris
 * keeper's two jobs on Arc (collections and credit reviews), what triggers
 * each, what their last reports did (each with its transaction), the keeper
 * itself (its address and its USDC for gas), and the credit guard, which
 * needs no keeper: it reads the pool live. Everything comes from the chain
 * (the receivers' events, read by this server's chain sync, and the guard's
 * views).
 */

export type WorkflowKey = "collections" | "underwrite";

export type TriggerKind = "timer" | "evm-log" | "http";

export type WorkflowTrigger = {
  kind: TriggerKind;
  /** "Timer", "Event", "Request". */
  label: string;
  /** "Every minute", "Reauthorized on PolarisCheckout", "Raise your limit in the app". */
  detail: string;
};

/** What one report did, in structured form (the page puts it in words with `describeRun`). */
export type KeeperRun = {
  txHash: `0x${string}`;
  explorerUrl: string | null;
  blockNumber: number;
  at: IsoDate;
  /** Who sent the report transaction (the keeper's EOA). */
  sender: `0x${string}` | null;
  collections?: {
    tasks: number;
    executed: number;
    skipped: number;
    /** Instalments collected (action 1), and how much, all merchants. */
    collected: number;
    collectedUnits: string;
    /** Subscriptions charged and plans liquidated. */
    charged: number;
    liquidated: number;
    /** Why tasks were skipped: reason → count. */
    skippedBy: Record<string, number>;
    /** This merchant's share: instalments collected on its plans, and how much. */
    yours: { collected: number; collectedUnits: string; dunned: number };
    /** The Reauthorized it followed (the instant retry), with how many seconds later. */
    afterReauthorization: { txHash: `0x${string}`; explorerUrl: string | null; at: IsoDate; seconds: number; yours: boolean } | null;
  };
  underwrite?: {
    applied: number;
    refused: number;
    /** Scores and refusals; the account only when it is one of this merchant's buyers. */
    items: Array<{ applied: boolean; score: number | null; reason: string | null; buyer: `0x${string}` | null }>;
  };
};

export type KeeperJob = {
  key: WorkflowKey;
  /** "Collections", "Credit reviews". */
  name: string;
  /** What it does, one line. */
  role: string;
  /** Its receiver contract on Arc. */
  receiver: `0x${string}` | null;
  receiverUrl: string | null;
  triggers: WorkflowTrigger[];
  /** Newest first. */
  runs: KeeperRun[];
  /** Reports in the last 24 hours. */
  runs24h: number;
  lastRunAt: IsoDate | null;
};

export type KeeperOverview = {
  /** False on a server with no deployment: the page then says nothing is deployed. */
  deployed: boolean;
  network: { chainId: number; name: string; explorerUrl: string | null } | null;
  /**
   * The keeper: the one EOA the receivers accept reports from, what it holds
   * for gas (USDC: Arc's gas token), and when it last said it was alive (a
   * collections heartbeat, sent every run, idle or not).
   */
  keeper: { address: `0x${string}` | null; addressUrl: string | null; gasUsdc: string | null; lastHeartbeatAt: IsoDate | null; reviewsOpen: boolean };
  workflows: KeeperJob[];
  guard: CreditGuard;
  readAt: IsoDate;
};

/** A run in one line, and its tone. */
export type RunLine = { title: string; detail: string; tone: "lime" | "purple" | "teal" | "amber" | "red" | "neutral" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const SKIP_WORDS: Record<string, string> = {
  insufficient_funds: "not enough in the account",
  allowance_lost: "approval lost, buyer asked to sign again",
  stale: "no longer due",
  other: "other",
};

/** A report in words, for the run lists. */
export function describeRun(workflow: WorkflowKey, run: KeeperRun): RunLine {
  if (workflow === "collections" && run.collections) {
    const c = run.collections;
    const bits: string[] = [];
    if (c.collected) bits.push(`${plural(c.collected, "instalment")} collected (${unitsToUsd(c.collectedUnits)})`);
    if (c.charged) bits.push(`${plural(c.charged, "subscription")} charged`);
    if (c.liquidated) bits.push(`${plural(c.liquidated, "plan")} closed`);
    const skipped = Object.entries(c.skippedBy).map(([reason, n]) => `${n} dunned: ${SKIP_WORDS[reason] ?? reason}`);
    const title = bits.length ? bits.join(" · ") : c.skipped ? plural(c.skipped, "task") + " skipped" : "Nothing due";
    const detail = [
      c.afterReauthorization ? `Instant retry: ${c.afterReauthorization.seconds} s after the buyer signed again` : null,
      ...skipped,
      c.yours.collected ? `Yours: ${plural(c.yours.collected, "instalment")}, ${unitsToUsd(c.yours.collectedUnits)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { title, detail: detail || `${plural(c.tasks, "task")} checked`, tone: c.collected || c.charged ? "lime" : c.skipped ? "amber" : "neutral" };
  }
  if (workflow === "underwrite" && run.underwrite) {
    const u = run.underwrite;
    const scores = u.items.filter((i) => i.applied && i.score !== null).map((i) => i.score);
    const refusals = u.items.filter((i) => !i.applied).map((i) => i.reason ?? "refused");
    return {
      title: u.applied ? `${plural(u.applied, "credit line")} opened` : `${plural(u.refused, "report")} refused`,
      detail: [scores.length ? `score ${scores.join(", ")}` : null, refusals.length ? `refused: ${refusals.join(", ")}` : null].filter(Boolean).join(" · ") || "Underwriting report",
      tone: u.applied ? "purple" : "amber",
    };
  }
  return { title: "Report", detail: "", tone: "neutral" };
}

/** Guard reason bits to names, for runs read from the API. */
export const guardReasons = reasonsFromMask;

/** The guard's reasons in words. */
export function guardReasonText(r: GuardReason): string {
  return GUARD_REASON_TEXT[r];
}
