import type { CreditGuard, GuardReason } from "./guard";
import { GUARD_REASON_TEXT, reasonsFromMask, unitsToUsd } from "./guard";
import type { IsoDate } from "./types";

/**
 * The dashboard's Chainlink page (`GET /api/chainlink`): the three Chainlink
 * CRE workflows Polaris runs, what triggers each, what their last reports did
 * on Monad (each with its transaction), the credit guard's verdict, and the
 * guardian read as a feed. Everything comes from the chain (the receivers'
 * events, read by this server's chain sync, and the guardian's views); the
 * schedules come from the workflows' own configs.
 */

export type WorkflowKey = "collections" | "underwrite" | "guardian";

export type TriggerKind = "cron" | "evm-log" | "http";

export type WorkflowTrigger = {
  kind: TriggerKind;
  /** "Cron", "EVM log", "HTTP". */
  label: string;
  /** "Every minute", "Reauthorized on PolarisCheckout", "Raise your limit in the app". */
  detail: string;
  /** The raw schedule, for a cron. */
  schedule?: string | null;
  /** The next time it fires, for a cron we could read. */
  nextAt?: IsoDate | null;
};

/** What one report did, in structured form (the page puts it in words with `describeRun`). */
export type ChainlinkRun = {
  txHash: `0x${string}`;
  explorerUrl: string | null;
  blockNumber: number;
  at: IsoDate;
  /** Delivered by: the forwarder's ReportProcessed and the transaction's sender. */
  delivery: { forwarder: `0x${string}`; transmitter: `0x${string}` | null; workflowExecutionId: `0x${string}` | null; result: boolean } | null;
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
  guardian?: {
    accepted: boolean;
    round: number | null;
    creditPaused: boolean | null;
    reasons: GuardReason[];
    /** AUSD/USD the workflow cited, in dollars, and that Chainlink round. */
    price: string | null;
    priceRoundId: string | null;
    freeCashUnits: string | null;
    observedAt: IsoDate | null;
    refusal: string | null;
  };
};

export type ChainlinkWorkflow = {
  key: WorkflowKey;
  /** The CRE workflow name: polaris-collections, polaris-underwrite, polaris-guardian. */
  name: string;
  /** What it does, one line. */
  role: string;
  /** Its receiver on Monad, and the workflow id it is locked to once deployed. */
  receiver: `0x${string}` | null;
  receiverUrl: string | null;
  workflowId: `0x${string}` | null;
  triggers: WorkflowTrigger[];
  /** Newest first. */
  runs: ChainlinkRun[];
  /** Reports in the last 24 hours. */
  runs24h: number;
  lastRunAt: IsoDate | null;
};

export type ChainlinkOverview = {
  /** False on a server with no deployment: the page then says nothing is deployed. */
  deployed: boolean;
  network: { chainId: number; name: string; explorerUrl: string | null } | null;
  /**
   * How reports reach the receivers:
   * - `production`: a deployed workflow's DON, through Chainlink's KeystoneForwarder;
   * - `simulation`: `cre workflow simulate --broadcast`, through Chainlink's MockKeystoneForwarder;
   * - `local`: a local chain (demo:local, or an anvil fork of Monad testnet): the workflows' local runner, through that chain's forwarder.
   */
  delivery: { forwarderKind: "production" | "simulation" | "local" | null; forwarder: `0x${string}` | null; locked: boolean; workflowOwner: `0x${string}` | null };
  workflows: ChainlinkWorkflow[];
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
export function describeRun(workflow: WorkflowKey, run: ChainlinkRun): RunLine {
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
  if (workflow === "guardian" && run.guardian) {
    const g = run.guardian;
    if (!g.accepted) return { title: "Attestation refused", detail: g.refusal ?? "Refused by GuardianReceiver", tone: "red" };
    const price = g.price ? `AUSD $${g.price}` : null;
    const cash = g.freeCashUnits ? `free cash ${unitsToUsd(g.freeCashUnits)}` : null;
    return {
      title: g.creditPaused ? "Pay in 4 paused" : "Pool healthy",
      detail: [g.creditPaused ? g.reasons.map((r) => GUARD_REASON_TEXT[r]).join(", ") : null, price, cash, g.round ? `round ${g.round}` : null]
        .filter(Boolean)
        .join(" · "),
      tone: g.creditPaused ? "amber" : "teal",
    };
  }
  return { title: "Report", detail: "", tone: "neutral" };
}

/** Guardian reason bits to names, for runs read from the API. */
export const guardReasons = reasonsFromMask;

/** "DON", "simulate --broadcast", "local run": how the page names who delivered a report (the app's words for a local run). */
export function deliveryLabel(kind: ChainlinkOverview["delivery"]["forwarderKind"]): string {
  if (kind === "production") return "Deployed on the CRE DON (KeystoneForwarder)";
  if (kind === "simulation") return "cre workflow simulate --broadcast (MockKeystoneForwarder)";
  if (kind === "local") return "CRE workflow, local run";
  return "Not deployed";
}
