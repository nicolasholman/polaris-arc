"use client";

import { EmptyState, ListRow, Sheet, Skeleton } from "@polaris/ui";
import { ArrowDownLeft, BellOff, CalendarClock, Check, Repeat, WalletCards } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { markNoticesSeen, useNotices } from "@/components/use-notices";
import type { Notice } from "@/lib/view";
import { when } from "@/lib/view";
import { RouteSheet } from "@/components/shell/sheet-host";

const LOOK: Record<Notice["kind"], { icon: ReactNode; tone: "surface" | "lime" | "purple" }> = {
  due: { icon: <CalendarClock />, tone: "purple" },
  in: { icon: <ArrowDownLeft />, tone: "lime" },
  claimed: { icon: <Check />, tone: "lime" },
  renews: { icon: <Repeat />, tone: "surface" },
  plan: { icon: <WalletCards />, tone: "surface" },
};

/** Notifications (half): payments coming up, money that arrived, links claimed. */
export function NotificationsSheet() {
  const router = useRouter();
  const { items, seenAt, newest } = useNotices();
  // What was new when the sheet opened stays marked while it is open.
  const [openedSeenAt, setOpenedSeenAt] = useState<number | null>(null);
  if (openedSeenAt === null && Number.isFinite(seenAt)) setOpenedSeenAt(seenAt);

  useEffect(() => {
    if (newest) markNoticesSeen(newest);
  }, [newest]);

  return (
    <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-2 pt-1">
      {items === undefined ? (
        [0, 1, 2, 3].map((i) => <Skeleton key={i} shape="row" height={68} />)
      ) : items.length === 0 ? (
        <EmptyState size="sm" icon={<BellOff />} title="All quiet" description="Payments due and money in show up here." />
      ) : (
        items.map((item) => {
          const fresh = item.at > (openedSeenAt ?? 0);
          return (
            <ListRow
              key={item.id}
              variant="card"
              icon={LOOK[item.kind].icon}
              tone={LOOK[item.kind].tone}
              title={item.title}
              description={`${when(item.at)} · ${item.detail}`}
              trailing={fresh ? <span role="img" aria-label="New" className="block size-2 rounded-full bg-ui-lime" /> : undefined}
              chevron={false}
              onClick={() => router.push(item.href, { scroll: false })}
            />
          );
        })
      )}
    </Sheet.Body>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function NotificationsRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet label="Notifications" title="Notifications" cold={cold} desktop={{ as: "drawer", size: "sm", title: "Notifications", description: "Payments due, money in, links claimed" }}>
      <NotificationsSheet />
    </RouteSheet>
  );
}
