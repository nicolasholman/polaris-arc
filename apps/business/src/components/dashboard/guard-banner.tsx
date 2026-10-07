"use client";

import { Button, Notice } from "@polaris/ui";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { GUARD_REASON_TEXT, lastCheckedLine } from "@/lib/data/guard";
import { useQuery } from "@/lib/session";

import { useNow } from "./common";

/**
 * On every dashboard page while the risk guard has paused Pay in 4: why,
 * what still works, and when it lifts. Read every 30 s from the same public
 * route the app and the shops read (`/api/public/credit-guard`), so the
 * merchant sees exactly what their buyers see.
 */
export function CreditGuardBanner({ className }: { className?: string }) {
  const guard = useQuery((d) => d.getCreditGuard(), { refreshMs: 30_000 });
  const pathname = usePathname() ?? "";
  const now = useNow(15_000);
  const g = guard.data;
  if (!g?.paused) return null;
  const why = g.reasons.map((r) => GUARD_REASON_TEXT[r]).join("; ");
  const lifts = g.reasons.includes("owner_pause")
    ? "Polaris lifts it by hand."
    : g.reasons.includes("bad_debt")
      ? "Bad debt never falls: Polaris acknowledges it by hand, and only new losses count after that."
      : "It lifts as soon as the check passes.";
  const checked = lastCheckedLine(g, now);
  return (
    <Notice
      tone="warn"
      role="status"
      icon={<ShieldAlert />}
      className={className}
      title="Pay in 4 is paused by the risk guard"
      action={
        pathname.startsWith("/dashboard/chainlink") ? undefined : (
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/chainlink">See the guard</Link>
          </Button>
        )
      }
    >
      {why ? `${why}. ` : ""}Buyers can&apos;t start new Pay in 4 plans; they can still pay now and subscribe, and open plans keep collecting. {lifts}
      {checked ? ` ${checked}.` : ""}
    </Notice>
  );
}
