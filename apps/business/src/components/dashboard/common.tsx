"use client";

import { Button, EmptyState, ErrorState, Notice, PanelCard, cn, type PanelCardProps } from "@polaris/ui";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { formatAgo } from "@/lib/data/format";
import type { QueryState } from "@/lib/session";

/** A dashboard panel: ref E's outlined card with a title row (title, subtitle, action). */
export function Panel({ title, ...props }: Omit<PanelCardProps, "title"> & { title: ReactNode }) {
  return <PanelCard title={title} {...props} />;
}

/** "See all": a real link with a 40px target. */
export function SeeAll({ href, children = "See all" }: { href: string; children?: ReactNode }) {
  return (
    <Link
      href={href}
      className="-my-2 -mr-3 inline-flex h-10 items-center rounded-full px-3 text-[15px] text-ui-muted transition-colors hover:bg-ui-surface-1 hover:text-ui-lime-active"
    >
      {children}
    </Link>
  );
}

/** A clock for "2 min ago" labels. Deliberately not in a live region, so it isn't re-announced. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * When a refresh fails while older data is on screen: say so, say when the
 * data is from, and offer a retry, instead of silently showing old numbers.
 */
export function StaleNotice({ queries }: { queries: QueryState<unknown>[] }) {
  const now = useNow(15_000);
  const stale = queries.find((q) => q.stale);
  if (!stale) return null;
  return (
    <Notice
      tone="warn"
      role="alert"
      className="mb-5"
      title={stale.updatedAt ? `Showing data from ${formatAgo(new Date(stale.updatedAt).toISOString(), now)}` : "Showing older data"}
      action={
        <Button variant="outline" size="sm" icon={<RotateCcw />} onClick={() => queries.forEach((q) => q.stale && q.reload())}>
          Retry
        </Button>
      }
    >
      The last refresh failed: {stale.error}
    </Notice>
  );
}

/** A failed first load inside a panel. */
export function LoadError({ query, title = "We couldn't load this" }: { query: QueryState<unknown>; title?: string }) {
  return <ErrorState size="sm" title={title} description={query.error ?? undefined} onRetry={query.reload} />;
}

/**
 * The note at the top of the money pages while nothing has settled yet: the
 * pages stay empty until real payments arrive, and say how to get the first.
 */
export function DataModeNotice({ empty, className }: { empty: boolean; className?: string }) {
  if (!empty) return null;
  return (
    <Notice
      tone="lime"
      className={cn("mb-5", className)}
      title="Your dashboard fills in as payments settle"
      action={
        <Button asChild variant="lime" size="sm">
          <Link href="/dashboard/links?new=1">New payment link</Link>
        </Button>
      }
    >
      Share a link and the first payment shows here within a second of the buyer confirming.
    </Notice>
  );
}

/**
 * The payout wallet's balance couldn't be read from Monad (the server's
 * `balanceCents` is null). Said as such, with a retry: never $0.00, and
 * nothing to withdraw against until it reads.
 */
export function BalanceUnknown({ onRetry, retrying, className }: { onRetry: () => void; retrying?: boolean; className?: string }) {
  return (
    <Notice
      tone="down"
      role="alert"
      className={className}
      title="Couldn't read your balance from Monad"
      action={
        <Button variant="outline" size="sm" icon={<RotateCcw />} loading={retrying} onClick={onRetry}>
          Retry
        </Button>
      }
    >
      Your money hasn&rsquo;t moved: the read failed. Withdrawals wait until the balance reads.
    </Notice>
  );
}

/** The inside of a panel with nothing to show yet. */
export function PanelEmpty({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <EmptyState size="sm" icon={icon} title={title} description={description} action={action} className="flex-1 justify-center" />;
}
