"use client";

import { Button, Notice } from "@polaris/ui";
import { ShieldAlert } from "lucide-react";
import { GUARD_PAUSED_MESSAGE, GUARD_REASON_LABELS } from "@/lib/credit-guard";
import { getCreditGuard } from "@/lib/data";
import { useData } from "@/lib/data/hooks";

/**
 * Pay in 4 while the credit guard has paused it: the guard's words, and the
 * way that still works. Shown in place of the plan wherever Pay in 4 is
 * offered (the checkout on a phone and from 1024px, the credit line).
 */
export function GuardPausedNotice({
  message,
  onPayNow,
  payNowLabel = "Pay now",
  className,
}: {
  message: string;
  onPayNow?: () => void;
  payNowLabel?: string;
  className?: string;
}) {
  return (
    <Notice
      tone="warn"
      role="status"
      icon={<ShieldAlert />}
      title="Pay in 4 is paused"
      className={className}
      action={
        onPayNow ? (
          <Button variant="white" size="sm" onClick={onPayNow}>
            {payNowLabel}
          </Button>
        ) : undefined
      }
    >
      {message}
    </Notice>
  );
}

/**
 * On the credit line (phone and desktop): while the credit guard has paused
 * Pay in 4, say so, why (low pool cash, unpaid plans, or Polaris's own
 * pause), and that paying now still works. Nothing while it is open.
 */
export function CreditGuardLine({ className }: { className?: string }) {
  const guard = useData(() => getCreditGuard(), []);
  const g = guard.value;
  if (!g?.paused) return null;
  const why = g.reasons.map((r) => GUARD_REASON_LABELS[r]).join(". ");
  return <GuardPausedNotice message={why ? `${g.message ?? GUARD_PAUSED_MESSAGE} ${why}.` : (g.message ?? GUARD_PAUSED_MESSAGE)} className={className} />;
}
