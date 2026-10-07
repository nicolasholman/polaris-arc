"use client";

import { ProvenanceBadge } from "@polaris/ui";
import type { CreditLine } from "@/lib/data/types";
import { shortDate } from "@/lib/dates";
import { provenanceOf } from "@/lib/provenance";

/**
 * Where the line and score came from, with a link to the report the CRE
 * underwriting workflow wrote on chain: "Verified by Chainlink CRE · Oct 2 ·
 * View report" for a DON-signed report, and "Chainlink CRE (simulated)" or
 * "CRE workflow, local run" (not shown as verified) for a report the CLI's
 * simulator or a local chain delivered (lib/provenance.ts). Nothing when there
 * is no report (a new account).
 */
export function CreditProvenance({ credit, size, className }: { credit: CreditLine | undefined; size?: "sm" | "md"; className?: string }) {
  const v = credit?.verified;
  if (!v) return null;
  const { label, verified } = provenanceOf(v);
  return (
    <ProvenanceBadge
      label={label}
      tone={verified ? "verified" : "neutral"}
      meta={shortDate(v.at)}
      href={v.explorerUrl}
      hash={v.txHash}
      linkLabel="View report"
      size={size}
      className={className}
    />
  );
}
