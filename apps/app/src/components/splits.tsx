"use client";

import { Button, FeaturedTile, PanelCard, SecondaryButton, SectionHeader, Skeleton, StatusPill, Ticks } from "@polaris/ui";
import { Plus, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useOwner } from "@/lib/account/hooks";
import { getSplits, type SplitStatus } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { shortDate } from "@/lib/dates";
import { usd } from "@/lib/money";
import { knownSplit, memoMatches, onKnownSplitsChanged, type SplitMemo } from "@/lib/split";

/**
 * The organiser's splits in Activity: each split you opened, what's come in
 * and how many have paid. A split opens its page, where you see who paid,
 * remind the rest or close it. Its words are this device's (the ones the
 * link carries); on another device a split reads "Your split".
 */

/** This device's split words, as stored: re-renders when they change (a split made in another tab). */
function useKnownSplitsSnapshot(): string | null {
  return useSyncExternalStore(onKnownSplitsChanged, readKnown, () => null);
}

function readKnown(): string | null {
  try {
    return window.localStorage.getItem("polaris.splits.v1");
  } catch {
    return null;
  }
}

export function splitWords(split: SplitStatus): SplitMemo | null {
  const known = knownSplit(split.id)?.memo ?? null;
  return memoMatches(known, split.memoHash) ? known : null;
}

/** The tile's last line; its subtitle already names the status ("Closed"), so this doesn't repeat it. */
function statusLine(split: SplitStatus): string {
  const paid = `${split.paidCount} of ${split.shareCount} paid`;
  return split.status === "open" ? `${paid} · until ${shortDate(split.expiresAt)}` : paid;
}

function useSplits() {
  const owner = useOwner();
  useKnownSplitsSnapshot();
  return useData(() => getSplits(owner), [owner]);
}

/** Phone: "Your splits", ref B's featured tiles with a tick per share. Nothing when you have none. */
export function SplitTiles({ className }: { className?: string }) {
  const router = useRouter();
  const splits = useSplits();
  if (!splits.value?.length) return null;
  return (
    <section aria-label="Your splits" className={className}>
      <SectionHeader title="Your splits" actionLabel="Split a bill" onAction={() => router.push("/split/new", { scroll: false })} />
      <div className="ui-no-scrollbar -mx-5 mt-3 flex gap-3 overflow-x-auto px-5">
        {splits.value.map((split) => {
          const memo = splitWords(split);
          const what = memo?.description || "Your split";
          return (
            <FeaturedTile
              key={split.id}
              leading={
                <span className="grid size-9 place-items-center rounded-full bg-ui-lime text-[#0f1011]">
                  <Users aria-hidden size={17} strokeWidth={2.25} />
                </span>
              }
              title={what}
              subtitle={split.status === "open" ? "Collecting" : split.status === "settled" ? "Everyone paid" : split.status === "closed" ? "Closed" : "Expired"}
              value={`${usd(split.paid)} of ${usd(split.total, { trim: true })}`}
              meta={statusLine(split)}
              progress={{ done: split.paidCount, total: split.shareCount }}
              className="w-auto min-w-[188px] grow basis-0"
              aria-label={`${what}: ${usd(split.paid)} of ${usd(split.total)} collected, ${split.paidCount} of ${split.shareCount} paid. Open`}
              onClick={() => router.push(`/split/${split.id}`, { scroll: false })}
            />
          );
        })}
      </div>
    </section>
  );
}

/** From 1024px: a panel in ref E's side column, one row per split, and Split a bill. */
export function SplitsPanel({ className }: { className?: string }) {
  const splits = useSplits();
  return (
    <PanelCard
      title="Your splits"
      subtitle="Each share lands with you the moment it's paid"
      padding="md"
      className={className}
      action={
        <Button asChild variant="ghost" size="sm" icon={<Plus />}>
          <Link href="/split/new" scroll={false}>
            New
          </Link>
        </Button>
      }
    >
      {!splits.value ? (
        <Skeleton shape="tile" height={120} className="mt-4" />
      ) : splits.value.length === 0 ? (
        <div className="mt-4 grid gap-3">
          <p className="text-[14px] leading-snug text-ui-muted">Paid for dinner, a trip or the rent? Split it: one link, and everyone pays their share in dollars.</p>
          <SecondaryButton asChild size="md" block icon={<Users />}>
            <Link href="/split/new" scroll={false}>
              Split a bill
            </Link>
          </SecondaryButton>
        </div>
      ) : (
        <ul className="mt-3 grid">
          {splits.value.slice(0, 5).map((split) => {
            const memo = splitWords(split);
            const what = memo?.description || "Your split";
            return (
              <li key={split.id} className="border-b border-ui-hairline last:border-b-0">
                <Link
                  href={`/split/${split.id}`}
                  scroll={false}
                  className="grid gap-2 rounded-[12px] px-1 py-3 transition-colors hover:bg-ui-surface-2/60 focus-visible:outline-2 focus-visible:outline-ui-focus"
                  aria-label={`${what}: ${split.paidCount} of ${split.shareCount} paid. Open`}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[15px] font-medium">{what}</span>
                    <StatusPill tone={split.status === "open" ? "amber" : split.status === "settled" ? "lime" : "neutral"} size="sm">
                      {split.status === "open" ? `${split.paidCount} of ${split.shareCount}` : split.status === "settled" ? "Paid" : split.status === "closed" ? "Closed" : "Expired"}
                    </StatusPill>
                  </span>
                  <Ticks done={split.paidCount} total={split.shareCount} size="sm" />
                  <span className="ui-figure text-[13px] text-ui-muted">
                    {usd(split.paid)} of {usd(split.total)} collected
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PanelCard>
  );
}
