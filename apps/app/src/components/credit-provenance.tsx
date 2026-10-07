"use client";

import { ProvenanceBadge } from "@polaris/ui";
import type { CreditLine } from "@/lib/data/types";
import { shortDate } from "@/lib/dates";
import { provenanceOf } from "@/lib/provenance";

/**
 * Where the line and score came from, with a link to the report the Polaris
 * keeper wrote on Arc: "Reviewed by the Polaris keeper · Oct 2 · View report"
 * (lib/provenance.ts), the transaction on the Arc explorer, or its hash where
 * there is no explorer (a local chain). Nothing when there is no report (a
 * new account).
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
