import type { CreditProvenance } from "./data/types";

/** What the app calls the report behind a credit line. */
export const KEEPER_REVIEW_LABEL = "Reviewed by the Polaris keeper";

/**
 * What the app may call a credit line's report: the underwriting decision the
 * Polaris keeper (services/keeper) submitted to UnderwritingReceiver on Arc,
 * with its transaction on the Arc explorer. It is shown as reviewed only when
 * there is a transaction to point at; anything else is named plainly.
 */
export function provenanceOf(v: Pick<CreditProvenance, "by" | "txHash">): { label: string; verified: boolean } {
  if (v.by === "Polaris keeper" && /^0x[0-9a-fA-F]{64}$/.test(v.txHash)) return { label: KEEPER_REVIEW_LABEL, verified: true };
  return { label: "Underwriting report", verified: false };
}
