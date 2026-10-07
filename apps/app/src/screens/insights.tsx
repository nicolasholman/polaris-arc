"use client";

import {
  DeltaBadge,
  EmptyState,
  GradientCard,
  HBarList,
  IconButton,
  LineArea,
  Money,
  ScreenHeader,
  Skeleton,
  Tab,
  TabList,
  Tabs,
  useIsDesktop,
} from "@polaris/ui";
import { Bell, CalendarDays, PieChart } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { FiltersSheet } from "@/components/filters-sheet";
import { TabScreen } from "@/components/screen";
import { InsightsDesktop } from "@/desktop/insights";
import { useNotices } from "@/components/use-notices";
import { useOwner } from "@/lib/account/hooks";
import { getActivity, getPlans } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import {
  dailySpending,
  type Period,
  PERIOD_LABEL,
  spendingByCategory,
  spentBetween,
} from "@/lib/view";
import { PlansView } from "./plans-view";

const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, all: 90 };

/** Insights, on ref A's third screen: the purple spending card, Expenses | Plans, the category bars. */
export function Insights() {
  return useIsDesktop() ? <InsightsDesktop /> : <InsightsPhone />;
}

function InsightsPhone() {
  const router = useRouter();
  const view = useSearchParams().get("view") === "plans" ? "plans" : "expenses";
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const { unread } = useNotices();
  const [period, setPeriod] = useState<Period>("week");
  const [filters, setFilters] = useState(false);

  const days = PERIOD_DAYS[period];
  const spent = activity.value ? spentBetween(activity.value, days, 0) : 0;
  const before = activity.value ? spentBetween(activity.value, days * 2, days) : 0;
  // Nothing spent in the period before: nothing to compare (as the desktop says), never "0.00%".
  const delta = before > 0 ? ((spent - before) / before) * 100 : null;
  const series = activity.value ? dailySpending(activity.value, days) : [];

  const categoryOf = (name: string) => {
    const all = [...(plans.value?.plans ?? []).map((p) => p.merchant), ...(plans.value?.subscriptions ?? []).map((s) => s.merchant)];
    return all.find((m) => m.name === name)?.category;
  };
  const bars = activity.value && plans.value ? spendingByCategory(activity.value, categoryOf, period) : undefined;

  return (
    <TabScreen>
      <ScreenHeader
        title="Insights"
        action={<IconButton label="Notifications" icon={<Bell />} tone="ghost" dot={unread} onClick={() => router.push("/notifications", { scroll: false })} />}
      />

      {activity.value ? (
        <GradientCard
          className="mt-2"
          tone="purple"
          layout="side"
          label="My spending"
          value={<Money value={spent} dim="none" />}
          meta={
            delta === null ? (
              <span className="text-[13px] opacity-80">Nothing to compare yet</span>
            ) : (
              <DeltaBadge value={delta} note={period === "week" ? "From last week" : period === "month" ? "From last month" : "From before"} size="sm" tone="current" />
            )
          }
          chart={<LineArea label={`Spending, ${PERIOD_LABEL[period].toLowerCase()}`} data={series} height={78} curve="linear" strokeWidth={2} glow={false} />}
        />
      ) : (
        <Skeleton shape="card" height={150} className="mt-2" />
      )}

      {/* As tall as the calendar button, so the rows below stay put when it goes. */}
      <div className="mt-6 flex min-h-[52px] items-center justify-between">
        <Tabs
          value={view}
          variant="text"
          onValueChange={(v) => router.replace(v === "plans" ? "/insights?view=plans" : "/insights", { scroll: false })}
        >
          <TabList aria-label="Insights">
            <Tab value="expenses">Expenses</Tab>
            <Tab value="plans">Plans</Tab>
          </TabList>
        </Tabs>
        {view === "expenses" ? (
          <IconButton label={`Period: ${PERIOD_LABEL[period]}`} icon={<CalendarDays />} tone="surface" size="lg" onClick={() => setFilters(true)} />
        ) : null}
      </div>

      {view === "expenses" ? (
        <div className="mt-5">
          {bars === undefined ? (
            <div className="flex flex-col gap-1.5">
              {[100, 72, 58, 36].map((w) => (
                <Skeleton key={w} shape="row" height={52} width={`${w}%`} />
              ))}
            </div>
          ) : bars.length === 0 ? (
            <EmptyState size="sm" icon={<PieChart />} title="Nothing spent yet" description={`No spending ${PERIOD_LABEL[period].toLowerCase()}.`} />
          ) : (
            <>
              <p className="mb-3 text-[14px] text-ui-muted">{PERIOD_LABEL[period]}, by category</p>
              <HBarList label={`Spending by category, ${PERIOD_LABEL[period].toLowerCase()}`} data={bars} />
            </>
          )}
        </div>
      ) : (
        <PlansView />
      )}

      <FiltersSheet
        open={filters}
        onOpenChange={setFilters}
        title="Period"
        sections={[
          {
            label: "Show spending for",
            value: period,
            options: (Object.keys(PERIOD_LABEL) as Period[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] })),
            onChange: (v) => setPeriod(v as Period),
          },
        ]}
        onReset={() => setPeriod("week")}
      />
    </TabScreen>
  );
}
