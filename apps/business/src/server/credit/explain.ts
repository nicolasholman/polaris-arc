import "server-only";

import { decodeUnderwritingReport, explainOnChainFacts } from "@polarispay/underwriting/core";
import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import { publicClient, requireChain } from "../chain/client";
import { polarisLoanEngineAbi } from "../chain/abis";
import { getConfig } from "../env";

/**
 * "Why is my limit this?", from what the keeper actually reported.
 *
 * The underwriting report the keeper wrote (its Facts: account age, who
 * funded it, related wallets, balances, from Arc and the linked wallet's
 * chains) is the calldata of its `UnderwritingReceiver.submitReport(report)`
 * transaction. We read that transaction and turn those facts into the
 * buyer's reasons with @polarispay/underwriting (`explainOnChainFacts`, the
 * same code the gateway's `POST /v1/explain` runs): plain lines, each with
 * the points it earned and the provider it came from. Nothing is recomputed
 * from fresh data: the reasons are the on-chain decision's. With
 * UNDERWRITING_GATEWAY_URL set the gateway explains it instead.
 */

const RECEIVER_ABI = parseAbi(["function submitReport(bytes report)"]);

export type ExplainedReason = { text: string; points: number | null; kind: string | null; provider: string | null };
export type Explanation = { score: number | null; limitUnits: string | null; reasons: ExplainedReason[]; source: "gateway" | "package" };

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;

/** Tests: replace the network the gateway is called over. */
export function configureExplainForTests(options: { fetch?: Fetch | null }): void {
  fetchImpl = options.fetch ?? null;
}

/** The report a keeper `submitReport` transaction carried, or null when it isn't one. */
export function reportFromKeeperCall(input: Hex): Hex | null {
  try {
    const call = decodeFunctionData({ abi: RECEIVER_ABI, data: input });
    return call.args[0] as Hex;
  } catch {
    return null;
  }
}

/**
 * Explain a report body for `user` in this process, with the underwriting
 * package. Null when the report doesn't carry that user.
 */
export function explainReport(user: Address, report: Hex, opts: { activeDebt: bigint; linked: boolean }): Explanation | null {
  const decoded = decodeUnderwritingReport(report);
  const item = decoded.items.find((i) => i.user.toLowerCase() === user.toLowerCase());
  if (!item) return null;
  const { decision } = explainOnChainFacts(item.facts, { activeDebt: opts.activeDebt, hasLinked: item.linkedWallet !== null || opts.linked });
  return fromWire(decision as unknown as WireDecision, "package");
}

/** Explain the underwriting delivered in `txHash` for `user`, or null when there is no report. */
export async function explainUnderwriting(user: Address, txHash: Hex, linked: boolean): Promise<Explanation | null> {
  const { underwriting } = getConfig();
  const chain = requireChain();
  const client = publicClient();
  const tx = await client.getTransaction({ hash: txHash });
  const report = reportFromKeeperCall(tx.input);
  if (!report) return null;
  const activeDebt = (await client
    .readContract({ address: chain.contracts.loanEngine, abi: polarisLoanEngineAbi, functionName: "activeDebtOf", args: [user] })
    .catch(() => 0n)) as bigint;

  if (!underwriting.gatewayUrl) return explainReport(user, report, { activeDebt, linked });

  const res = await (fetchImpl ?? fetch)(`${underwriting.gatewayUrl}/v1/explain`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(underwriting.apiToken ? { authorization: `Bearer ${underwriting.apiToken}` } : {}) },
    body: JSON.stringify({ report, activeDebt: activeDebt.toString(), hasLinked: linked ? true : undefined }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the underwriting gateway answered ${res.status}`);
  const out = (await res.json()) as {
    items?: Array<{ user?: string | null; decision?: WireDecision }>;
    decision?: WireDecision;
  };
  const item = out.items?.find((i) => i.user?.toLowerCase() === user.toLowerCase()) ?? (out.items?.length ? null : { decision: out.decision });
  const decision = item?.decision;
  if (!decision) return null;
  return fromWire(decision, "gateway");
}

function fromWire(decision: WireDecision, source: Explanation["source"]): Explanation {
  return {
    score: typeof decision.score === "number" ? decision.score : null,
    limitUnits: decision.limit !== undefined && decision.limit !== null ? String(decision.limit) : null,
    reasons: (decision.reasons ?? []).slice(0, 20).map((r) => ({
      text: String(r.text ?? r.label ?? ""),
      points: typeof r.points === "number" ? r.points : null,
      kind: typeof r.kind === "string" ? r.kind : null,
      provider: typeof r.provider === "string" ? r.provider : null,
    })),
    source,
  };
}

type WireDecision = {
  score?: number;
  limit?: string | number | bigint | null;
  reasons?: Array<{ text?: string; label?: string; points?: number; kind?: string; provider?: string }>;
};
