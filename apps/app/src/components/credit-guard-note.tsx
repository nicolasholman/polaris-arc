"use client";

import { Button, Notice } from "@polaris/ui";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { GUARD_PAUSED_MESSAGE, staleGuardLine } from "@/lib/credit-guard";
import { getCreditGuard } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import type { CreditGuardView } from "@/lib/data/types";
import { useNow } from "@/lib/use-now";

/**
 * Pay in 4 while the risk guard has paused it: the guard's words, and the
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
 * "Risk guard last checked 72 min ago · Pay in 4 stays on": when the guard
 * has stopped reporting it no longer blocks anything (it fails open), and
 * the buyer is told how old its last check is. Nothing when it is fresh.
 */
export function GuardStaleLine({ guard, className }: { guard: CreditGuardView | null | undefined; className?: string }) {
  const now = useNow();
  // Nothing during server render: the age depends on the clock.
  const line = now === null ? null : staleGuardLine(guard, now);
  if (!line) return null;
  return (
    <p className={className ?? "flex items-center gap-2 text-[13px] leading-snug text-ui-muted"}>
      <ShieldCheck aria-hidden size={16} strokeWidth={1.75} className="shrink-0" />
      <span>
        {line} · Pay in 4 stays on
      </span>
    </p>
  );
}

/**
 * On the credit line (phone and desktop): while the risk guard has paused
 * Pay in 4, say so and that paying now still works; while it is late, say
 * how old its last check is. Nothing when it is fresh and open.
 */
export function CreditGuardLine({ className }: { className?: string }) {
  const guard = useData(() => getCreditGuard(), []);
  const g = guard.value;
  if (!g) return null;
  if (g.paused) return <GuardPausedNotice message={g.message ?? GUARD_PAUSED_MESSAGE} className={className} />;
  return <GuardStaleLine guard={g} className={className} />;
}
