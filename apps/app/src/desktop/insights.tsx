"use client";

import {
  BalanceSummaryCard,
  DollarCoin,
  DonutChart,
  EmptyState,
  FigureRow,
  GradientLineChart,
  HBarList,
  Money,
  PanelCard,
  PrimaryButton,
  SecondaryButton,
  Skeleton,
  StatusPill,
  TableName,
  TimeframeChips,
} from "@polaris/ui";
import { ArrowRightLeft, CalendarClock, ChartColumn, PieChart } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MerchantAvatar, PersonAvatar } from "@/components/avatars";
import { useOwner } from "@/lib/account/hooks";
import { type ActivityItem, getActivity, getPlans } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { toNumber, usd } from "@/lib/money";
import { spendingSeries } from "@/lib/series";
import { useNow } from "@/lib/use-now";
import { movesBalance, type Period, spendingByCategory, spentBetween } from "@/lib/view";
import { PageCoin, PageGrid, PageHead, SideNote } from "./bits";

const RANGES = [
  { value: "week", label: "1w", days: 7, title: "this week", versus: "vs last week" },
  { value: "month", label: "1m", days: 30, title: "this month", versus: "vs last month" },
  { value: "all", label: "3m", days: 90, title: "in 3 months", versus: "vs the 3 months before" },
] as const;

/** Ref E's own tints for the categories, in order. */
const TINTS = [
  "var(--ui-lime-button)",
  "var(--ui-pill-purple-text)",
  "var(--ui-pill-teal-text)",
  "var(--ui-chart-bottom)",
  "var(--ui-chart-mid)",
  "var(--ui-pill-neutral-text)",
];

const KINDS: { label: string; color: string; test: (a: ActivityItem) => boolean }[] = [
  { label: "Paid in full", color: "var(--ui-lime-button)", test: (a) => a.kind === "payment" },
  { label: "Pay in 4", color: "var(--ui-pill-purple-text)", test: (a) => a.kind === "instalment" },
  { label: "Subscriptions", color: "var(--ui-pill-teal-text)", test: (a) => a.kind === "subscription" },
  { label: "Links and transfers", color: "var(--ui-chart-bottom)", test: (a) => a.kind === "sent-link" || a.kind === "sent" },
];

const money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Insights from 1024px: your spending as ref E's line (a running total over
 * the period), what it went on by category and by kind, and your top
 * merchants. Plans have their own page here (Pay in 4).
 */
export function InsightsDesktop() {
  const router = useRouter();
  const view = useSearchParams().get("view");
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const [range, setRange] = useState<Period>("week");
  const minute = useNow();

  // The phone's Insights → Plans is its own page on a desktop.
  useEffect(() => {
    if (view === "plans") router.replace("/plans");
  }, [view, router]);

  const r = RANGES.find((x) => x.value === range)!;
  const now = minute && activity.value ? Math.max(minute, ...activity.value.map((a) => a.at)) : minute;
  const data = useMemo(() => {
    if (!activity.value || !plans.value || !now) return null;
    const list = activity.value;
    const series = spendingSeries(list, r.days, now);
    const before = spentBetween(list, r.days * 2, r.days, now);
    const categoryOf = (name: string) =>
      [...plans.value!.plans.map((p) => p.merchant), ...plans.value!.subscriptions.map((s) => s.merchant)].find((m) => m.name === name)?.category;
    const bars = spendingByCategory(list, categoryOf, range);
    const out = list.filter((a) => a.direction === "out" && movesBalance(a) && now - a.at <= r.days * 86_400_000);
    const kinds = KINDS.map((k) => ({ label: k.label, color: k.color, value: out.filter(k.test).reduce((s, a) => s + toNumber(a.amount), 0) })).filter((k) => k.value > 0);
    const merchants = new Map<string, { name: string; amount: number; count: number; merchant: boolean }>();
    for (const a of out) {
      const m = merchants.get(a.title) ?? { name: a.title, amount: 0, count: 0, merchant: a.counterparty.kind === "merchant" };
      m.amount += toNumber(a.amount);
      m.count += 1;
      merchants.set(a.title, m);
    }
    // The side card's own figures: the calendar month so far, and the month
    // behind it (never the page's figure again).
    const DAY_MS = 86_400_000;
    const monthStart = new Date(now);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const spent = list.filter((a) => a.direction === "out" && movesBalance(a) && a.at <= now);
    const soFar = spent.filter((a) => a.at >= monthStart.getTime());
    const last30 = spent.filter((a) => now - a.at <= 30 * DAY_MS);
    const at = new Map<string, number>();
    for (const a of last30) at.set(a.title, (at.get(a.title) ?? 0) + toNumber(a.amount));
    const most = [...at.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      series,
      delta: before > 0 ? ((series.total - before) / before) * 100 : null,
      bars,
      kinds,
      top: [...merchants.values()].sort((a, b) => b.amount - a.amount).slice(0, 4),
      count: out.length,
      month: {
        label: monthStart.toLocaleDateString("en-US", { month: "long" }),
        total: soFar.reduce((s, a) => s + toNumber(a.amount), 0),
        count: soFar.length,
        perWeek: last30.reduce((s, a) => s + toNumber(a.amount), 0) / (30 / 7),
        most: most?.[0] ?? null,
      },
    };
  }, [activity.value, plans.value, now, r.days, range]);

  const time = (t: string | number | Date) => new Date(t).toLocaleDateString("en-US", r.days <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" });

  return (
    <>
      <PageHead title="Insights" coins={[<PageCoin key="i" tone="orange"><ChartColumn /></PageCoin>, <DollarCoin key="d" size={50} />]} />
      <PageGrid
        main={
          <>
            <FigureRow
              caption={`Spent ${r.title}`}
              value={data ? <Money value={data.series.total} /> : undefined}
              delta={data ? data.delta : undefined}
              deltaSuffix={r.versus}
              deltaLabel={data && data.delta === null ? "Nothing to compare yet" : undefined}
              // Spending: less is the good news, more turns amber.
              deltaGoodWhen="down"
              right={
                <TimeframeChips<Period>
                  aria-label="Period"
                  options={RANGES.map((x) => ({ value: x.value, label: x.label, title: x.title }))}
                  value={range}
                  onValueChange={setRange}
                />
              }
            />
            <div className="mt-6">
              {!data ? (
                <Skeleton shape="card" height={340} />
              ) : (
                <GradientLineChart
                  key={range}
                  label={`Money you spent ${r.title}, as a running total`}
                  data={data.series.points}
                  height={340}
                  formatValue={money}
                  formatAxis={(v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  formatTime={time}
                  formatBubbleNote={null}
                  defaultIndex={data.series.points.length - 1}
                  lastLabel="Today"
                  empty={<p className="text-[15px] text-ui-muted">Nothing spent {r.title}.</p>}
                />
              )}
            </div>

            <div className="mt-10 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <PanelCard title="By category" subtitle={`Share of what you spent ${r.title}`}>
                {!data ? (
                  <Skeleton shape="tile" height={220} className="mt-5" />
                ) : data.bars.length === 0 ? (
                  <EmptyState size="sm" icon={<PieChart />} title="Nothing spent yet" description={`No spending ${r.title}.`} />
                ) : (
                  <HBarList
                    className="mt-5"
                    label={`Spending by category, ${r.title}`}
                    data={data.bars.map((b, i) => ({ label: b.label, value: b.value, color: TINTS[i % TINTS.length] }))}
                  />
                )}
              </PanelCard>
              <PanelCard title="By kind" subtitle="In full, in four, every month, or by link">
                {!data ? (
                  <Skeleton shape="tile" height={220} className="mt-5" />
                ) : data.kinds.length === 0 ? (
                  <EmptyState size="sm" icon={<ArrowRightLeft />} title="Nothing spent yet" description={`No spending ${r.title}.`} />
                ) : (
                  <div className="mt-5 grid justify-items-center gap-5">
                    <DonutChart
                      label={`Spending by kind, ${r.title}`}
                      data={data.kinds}
                      size={188}
                      gap={3}
                      formatValue={money}
                      centerLabel="Spent"
                      centerValue={money(data.series.total)}
                    />
                    <ul className="grid w-full min-w-0 gap-2.5">
                      {data.kinds.map((k) => (
                        <li key={k.label} className="flex items-center gap-2.5 text-[14px]">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: k.color }} />
                          <span className="min-w-0 flex-1 truncate text-ui-muted">{k.label}</span>
                          <span className="ui-figure">{money(k.value)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </PanelCard>
            </div>
          </>
        }
        side={
          <>
            {data ? (
              <BalanceSummaryCard
                label={`${data.month.label} so far`}
                value={<Money value={data.month.total} />}
                badge={<StatusPill tone="neutral" size="sm">{data.month.count} {data.month.count === 1 ? "payment" : "payments"}</StatusPill>}
                stats={[
                  { label: "A week, on average", value: money(data.month.perWeek) },
                  { label: "Most at", value: data.month.most ?? "Nowhere yet" },
                ]}
              />
            ) : (
              <Skeleton shape="card" height={170} />
            )}
            <PanelCard title="Where you spent most" padding="md">
              {data ? (
                data.top.length ? (
                  <ul className="mt-4 grid gap-4">
                    {data.top.map((m) => (
                      <li key={m.name} className="flex items-center gap-3">
                        <TableName
                          className="min-w-0 flex-1"
                          icon={m.merchant ? <MerchantAvatar name={m.name} size="sm" /> : <PersonAvatar name={m.name} size="sm" />}
                          title={m.name}
                          sub={`${m.count} ${m.count === 1 ? "payment" : "payments"}`}
                        />
                        <span className="ui-figure text-[15px]">{usd(BigInt(Math.round(m.amount * 1e6)))}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-[14px] text-ui-muted">Nothing spent {r.title}.</p>
                )
              ) : (
                <Skeleton shape="tile" height={180} className="mt-4" />
              )}
            </PanelCard>
            <PrimaryButton asChild size="lg" block icon={<CalendarClock />} className="mt-1">
              <Link href="/plans">Your Pay in 4 plans</Link>
            </PrimaryButton>
            <SecondaryButton asChild size="lg" block iconRight={<ArrowRightLeft />}>
              <Link href="/activity">All activity</Link>
            </SecondaryButton>
            <SideNote>Spending counts money that left your dollar account. Opening a Pay in 4 plan doesn&apos;t: its four payments do, as they go out.</SideNote>
          </>
        }
      />
    </>
  );
}
