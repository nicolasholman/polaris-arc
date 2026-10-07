"use client";

import { useSyncExternalStore } from "react";
import { useOwner } from "@/lib/account/hooks";
import { getActivity, getCreditLine, getPlans } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { type Notice, notices } from "@/lib/view";

const KEY = "polaris.notices.seen";
const EVENT = "polaris:notices";

function readSeen(): number {
  try {
    return Number(window.localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

/** Marks everything up to `newest` as seen. Idempotent: it only writes when that moves. */
export function markNoticesSeen(newest: number): void {
  if (newest <= readSeen()) return;
  try {
    window.localStorage.setItem(KEY, String(newest));
  } catch {
    /* the dot stays; harmless */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The bell's feed, whether anything in it is new since it was last opened, and the newest notice's time. */
export function useNotices(): { items: Notice[] | undefined; unread: boolean; seenAt: number; newest: number } {
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const credit = useData(() => getCreditLine(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const seenAt = useSyncExternalStore(subscribe, readSeen, () => Number.POSITIVE_INFINITY);

  const items =
    activity.value && plans.value ? notices(activity.value, credit.value, plans.value) : undefined;
  const newest = items?.[0]?.at ?? 0;

  return { items, unread: items?.some((i) => i.at > seenAt) ?? false, seenAt, newest };
}
