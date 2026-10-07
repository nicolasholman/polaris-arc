import type { CreditReason } from "@/lib/data";

/** A credit reason in the buyer's words, and where the fact came from ("from Nansen") when a provider supplied it. */
export function ReasonLabel({ reason }: { reason: CreditReason }) {
  return (
    <>
      {reason.label}
      {reason.source ? <span className="text-ui-muted"> · from {reason.source}</span> : null}
    </>
  );
}
