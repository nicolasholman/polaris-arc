"use client";

import {
  BalanceSummaryCard,
  DataTable,
  DollarCoin,
  EmptyState,
  FigureRow,
  IconSquareButton,
  Input,
  Money,
  PanelCard,
  PrimaryButton,
  ProgressLegend,
  SecondaryButton,
  Skeleton,
  TimeframeChips,
} from "@polaris/ui";
import { ArrowRightLeft, ArrowUpRight, Plus, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useAccounts } from "@/components/accounts";
import { FiltersSheet } from "@/components/filters-sheet";
import { SplitsPanel } from "@/components/splits";
import { useOwner } from "@/lib/account/hooks";
import { type ActivityItem, getActivity } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { toNumber } from "@/lib/money";
import { inPeriod, movesBalance, n, type Period, PERIOD_LABEL } from "@/lib/view";
import { activityColumns, PageCoin, PageGrid, PageHead, SideColumn, SideNote } from "./bits";

type Quick = "all" | "in" | "out" | "plans" | "links";

const KIND_OF: Record<ActivityItem["kind"], "payments" | "plans" | "subscriptions" | "links" | "transfers"> = {
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

const QUICK: { value: Quick; label: string; test: (a: ActivityItem) => boolean }[] = [
  { value: "all", label: "All", test: () => true },
  { value: "in", label: "Money in", test: (a) => a.direction === "in" },
  { value: "out", label: "Money out", test: (a) => a.direction === "out" },
  { value: "plans", label: "Pay in 4", test: (a) => KIND_OF[a.kind] === "plans" },
  { value: "links", label: "Links", test: (a) => KIND_OF[a.kind] === "links" },
];

const dollars = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SPEND_KINDS = [
  { key: "payments", label: "Paid in full", color: "var(--ui-lime-button)" },
  { key: "plans", label: "Pay in 4", color: "var(--ui-pill-purple-text)" },
  { key: "subscriptions", label: "Subscriptions", color: "var(--ui-pill-teal-text)" },
  { key: "links", label: "Links and transfers", color: "var(--ui-chart-bottom)" },
] as const;

/**
 * Activity from 1024px, in the merchant Payments page's rhythm: the page's
 * coins, what went out over the period with what came in, the filter chips,
 * ref E's table (a row opens its details in a Drawer), and on the right your
 * dollar account and where the money went.
 */
export function ActivityDesktop() {
  const router = useRouter();
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const { balance } = useAccounts();
  const [quick, setQuick] = useState<Quick>("all");
  const [period, setPeriod] = useState<Period>("all");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(false);
  const list = activity.value;

  const month = useMemo(() => {
    if (!list) return null;
    const recent = list.filter((a) => inPeriod(a, "month") && movesBalance(a));
    const sum = (xs: ActivityItem[]) => xs.reduce((s, a) => s + toNumber(a.amount), 0);
    const out = recent.filter((a) => a.direction === "out");
    const spend = SPEND_KINDS.map((k) => ({
      ...k,
      amount: sum(out.filter((a) => (k.key === "links" ? KIND_OF[a.kind] === "links" || KIND_OF[a.kind] === "transfers" : KIND_OF[a.kind] === k.key))),
    }));
    const total = sum(out);
    return { in: sum(recent.filter((a) => a.direction === "in")), out: total, count: recent.length, spend: spend.map((s) => ({ ...s, share: total ? (s.amount / total) * 100 : 0 })) };
  }, [list]);

  const q = query.trim().toLowerCase();
  const rows =
    list?.filter(
      (a) =>
        QUICK.find((x) => x.value === quick)!.test(a) &&
        inPeriod(a, period) &&
        (!q || `${a.title} ${a.detail}`.toLowerCase().includes(q)),
    ) ?? [];
  const counts = (value: Quick) => list?.filter((a) => QUICK.find((x) => x.value === value)!.test(a) && inPeriod(a, period)).length ?? 0;

  return (
    <>
      <PageHead
        title="Activity"
        coins={[<PageCoin key="a" tone="purple"><ArrowRightLeft /></PageCoin>, <DollarCoin key="d" size={50} />]}
        actions={
          <IconSquareButton
            label={`When: ${PERIOD_LABEL[period]}`}
            icon={<SlidersHorizontal />}
            tone={period !== "all" ? "solid" : "outline"}
            active={period !== "all"}
            onClick={() => setFilters(true)}
          />
        }
      />
      <PageGrid
        stack
        main={
          <>
            <FigureRow
              caption="Spent, last 30 days"
              value={month ? <Money value={month.out} /> : undefined}
              deltaLabel={month ? `+${dollars(month.in)} in` : undefined}
              deltaTitle="What came into your dollar account in the same 30 days"
              right={
                <TimeframeChips<Quick>
                  aria-label="Show"
                  options={QUICK.map((x) => ({ value: x.value, label: list ? `${x.label} ${counts(x.value)}` : x.label }))}
                  value={quick}
                  onValueChange={setQuick}
                />
              }
            />
            <Input
              hideLabel
              label="Search activity"
              type="search"
              placeholder="Search a merchant, a person or what it was for"
              icon={<Search />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              wrapperClassName="mt-6"
              className="h-12"
            />
            <div className="mt-4">
              {list && rows.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={<ArrowRightLeft />}
                  title={list.length ? "Nothing matches" : "Nothing here yet"}
                  description={list.length ? "Try another word, or show everything." : "Payments, links and instalments show up the moment they happen."}
                />
              ) : (
                <DataTable
                  caption="All activity"
                  loading={!list}
                  loadingRows={8}
                  rows={rows}
                  rowKey={(a) => a.id}
                  onRowClick={(a) => router.push(`/activity/${a.id}`, { scroll: false })}
                  columns={activityColumns({ whenStyle: "full" })}
                />
              )}
            </div>
          </>
        }
        side={
          <>
            <SideColumn>
              {balance && month ? (
                <BalanceSummaryCard
                  label="Dollar account"
                  value={<Money value={n(balance.available)} />}
                  stats={[
                    { label: "In, 30 days", value: dollars(month.in) },
                    { label: "Out, 30 days", value: dollars(month.out) },
                    { label: "Fees", value: "$0.00" },
                  ]}
                />
              ) : (
                <Skeleton shape="card" height={170} />
              )}
              <PrimaryButton asChild size="lg" block icon={<ArrowUpRight />} className="mt-1">
                <Link href="/send" scroll={false}>
                  Send money
                </Link>
              </PrimaryButton>
              <SecondaryButton asChild size="lg" block iconRight={<Plus />}>
                <Link href="/add" scroll={false}>
                  Add money
                </Link>
              </SecondaryButton>
            </SideColumn>
            <SideColumn>
              <SplitsPanel />
              <PanelCard title="Where it went" subtitle="Share of spending, last 30 days" padding="md">
                {month ? (
                  month.out > 0 ? (
                    <ProgressLegend
                      className="mt-5"
                      direction="column"
                      items={month.spend.map((s) => ({ label: s.label, value: Math.round(s.share), color: s.color }))}
                    />
                  ) : (
                    <p className="mt-4 text-[14px] text-ui-muted">Nothing spent in the last 30 days.</p>
                  )
                ) : (
                  <Skeleton shape="tile" height={140} className="mt-4" />
                )}
              </PanelCard>
              <SideNote>Every payment lands in under a second. Sending and paying in full cost nothing; Pay in 4 is 10% a year, with every payment and the interest shown before you confirm.</SideNote>
            </SideColumn>
          </>
        }
      />

      <FiltersSheet
        open={filters}
        onOpenChange={setFilters}
        title="When"
        sections={[
          {
            label: "Show activity from",
            value: period,
            options: (Object.keys(PERIOD_LABEL) as Period[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] })),
            onChange: (v) => setPeriod(v as Period),
          },
        ]}
        onReset={() => setPeriod("all")}
      />
    </>
  );
}
