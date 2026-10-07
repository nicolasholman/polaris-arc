"use client";

import { Chip, EmptyState, IconButton, ScreenHeader, SectionHeader, Skeleton, TxRow, useIsDesktop } from "@polaris/ui";
import { ArrowRightLeft, SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { rowAmount } from "@/components/activity-amount";
import { ActivityAvatar } from "@/components/avatars";
import { FiltersSheet } from "@/components/filters-sheet";
import { ReceiptWhat } from "@/components/sealed-receipt";
import { TabScreen } from "@/components/screen";
import { SplitTiles } from "@/components/splits";
import { ActivityDesktop } from "@/desktop/activity";
import { useOwner } from "@/lib/account/hooks";
import { type ActivityItem, getActivity } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { dayLabel, time } from "@/lib/dates";
import { inPeriod, type Period, PERIOD_LABEL, subAmount } from "@/lib/view";

type Direction = "all" | "in" | "out";
type Kind = "all" | "payments" | "plans" | "subscriptions" | "links" | "transfers";
type Filters = { direction: Direction; kind: Kind; period: Period };

const DEFAULTS: Filters = { direction: "all", kind: "all", period: "all" };

const KIND_OF: Record<ActivityItem["kind"], Kind> = {
  payment: "payments",
  instalment: "plans",
  "plan-opened": "plans",
  subscription: "subscriptions",
  "sent-link": "links",
  claimed: "links",
  sent: "transfers",
  received: "transfers",
  refund: "transfers",
  added: "transfers",
  "split-paid": "links",
  "split-received": "links",
};

const QUICK: { id: string; label: string; set: Partial<Filters> }[] = [
  { id: "all", label: "All", set: { direction: "all", kind: "all" } },
  { id: "in", label: "Money in", set: { direction: "in", kind: "all" } },
  { id: "out", label: "Money out", set: { direction: "out", kind: "all" } },
  { id: "plans", label: "Pay in 4", set: { direction: "all", kind: "plans" } },
  { id: "links", label: "Links", set: { direction: "all", kind: "links" } },
];

function groupByDay(items: ActivityItem[]): { label: string; items: ActivityItem[] }[] {
  const groups: { label: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Activity: ref D's transactions on a phone, ref E's table from 1024px. */
export function Activity() {
  return useIsDesktop() ? <ActivityDesktop /> : <ActivityPhone />;
}

/** Activity, on ref D's transactions: filter chips, then rows grouped by day. */
function ActivityPhone() {
  const router = useRouter();
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [open, setOpen] = useState(false);

  const items =
    activity.value?.filter(
      (i) =>
        (filters.direction === "all" || i.direction === filters.direction) &&
        (filters.kind === "all" || KIND_OF[i.kind] === filters.kind) &&
        inPeriod(i, filters.period),
    ) ?? [];
  const groups = groupByDay(items);
  const quick = QUICK.find((q) => q.set.direction === filters.direction && q.set.kind === filters.kind)?.id;
  const filtered = filters.period !== "all" || !quick;

  return (
    <TabScreen>
      <ScreenHeader
        title="Activity"
        action={
          <IconButton
            label="Filters"
            icon={<SlidersHorizontal />}
            tone={filtered ? "lime" : "surface"}
            dot={false}
            onClick={() => setOpen(true)}
          />
        }
      />

      <div role="radiogroup" aria-label="Show" className="ui-no-scrollbar -mx-5 mt-2 flex gap-1.5 overflow-x-auto px-5 pb-1">
        {QUICK.map((q) => (
          <Chip
            key={q.id}
            role="radio"
            aria-checked={quick === q.id}
            selected={quick === q.id}
            variant="outline"
            onClick={() => setFilters((f) => ({ ...f, ...q.set }))}
          >
            {q.label}
          </Chip>
        ))}
      </div>

      <SplitTiles className="mt-6" />

      <SectionHeader
        title="All activity"
        actionLabel="Analytics"
        onAction={() => router.push("/insights")}
        size="lg"
        className="mt-6"
      />

      <div className="mt-3 flex flex-col gap-5">
        {activity.value === undefined ? (
          <div className="flex flex-col gap-2.5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} shape="row" height={64} className="rounded-[22px]" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<ArrowRightLeft />}
            title="Nothing here"
            description={filtered || quick !== "all" ? "Nothing matches these filters." : "Payments, links and instalments show up the moment they happen."}
          />
        ) : (
          groups.map((group) => (
            <section key={group.label} aria-label={group.label} className="flex flex-col gap-2.5">
              <h3 className="px-1 text-[14px] font-medium text-ui-muted">{group.label}</h3>
              {group.items.map((item) => (
                <TxRow
                  key={item.id}
                  variant="card"
                  leading={<ActivityAvatar item={item} />}
                  title={item.title}
                  subtitle={
                    item.receiptId ? (
                      <>
                        {time(item.at)} · <ReceiptWhat item={item} fallback={subAmount(item)} />
                      </>
                    ) : (
                      `${time(item.at)} · ${subAmount(item)}`
                    )
                  }
                  {...rowAmount(item)}
                  onClick={() => router.push(`/activity/${item.id}`, { scroll: false })}
                />
              ))}
            </section>
          ))
        )}
      </div>

      <FiltersSheet
        open={open}
        onOpenChange={setOpen}
        onReset={() => setFilters(DEFAULTS)}
        sections={[
          {
            label: "Direction",
            value: filters.direction,
            options: [
              { value: "all", label: "All" },
              { value: "in", label: "Money in" },
              { value: "out", label: "Money out" },
            ],
            onChange: (v) => setFilters((f) => ({ ...f, direction: v as Direction })),
          },
          {
            label: "Type",
            value: filters.kind,
            options: [
              { value: "all", label: "All" },
              { value: "payments", label: "Paid in full" },
              { value: "plans", label: "Pay in 4" },
              { value: "subscriptions", label: "Subscriptions" },
              { value: "links", label: "Links" },
              { value: "transfers", label: "Transfers" },
            ],
            onChange: (v) => setFilters((f) => ({ ...f, kind: v as Kind })),
          },
          {
            label: "When",
            value: filters.period,
            options: (Object.keys(PERIOD_LABEL) as Period[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] })),
            onChange: (v) => setFilters((f) => ({ ...f, period: v as Period })),
          },
        ]}
      />
    </TabScreen>
  );
}
