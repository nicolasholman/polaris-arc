"use client";

import {
  CandlestickChart,
  ChartTypeToggle,
  type ChartType,
  cn,
  DataTable,
  DollarCoin,
  EmptyState,
  FigureRow,
  GradientLineChart,
  Money,
  PairHeader,
  PolarisCoin,
  PrimaryButton,
  Skeleton,
  TimeframeChips,
} from "@polaris/ui";
import { ArrowRight, ArrowRightLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { useAccounts } from "@/components/accounts";
import { SignAgainNotice } from "@/components/sign-again";
import { useOwner } from "@/lib/account/hooks";
import { getActivity, getPlans, getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { toNumber } from "@/lib/money";
import { type HomeAccount, setPrefs } from "@/lib/prefs";
import { balanceSeries, boostSeries, creditSeries, type Frame, FRAMES, restIndex, type Series } from "@/lib/series";
import { useNow } from "@/lib/use-now";
import { activityColumns } from "./bits";
import { MoneyWidget } from "./money-widget";

const ACCOUNTS: { value: HomeAccount; label: string; description: string }[] = [
  { value: "dollar", label: "Balance / USD", description: "Your dollar account" },
  { value: "later", label: "Pay later / USD", description: "What Pay in 4 can spend" },
  { value: "boost", label: "Boost / USD", description: "Dollars locked to raise your line" },
];

const axis = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (v: number) => `$${axis(v)}`;

function timeLabel(frame: Frame) {
  return (t: string | number | Date) => {
    const d = new Date(t);
    if (frame === "1h" || frame === "24h") return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (frame === "1w") return d.toLocaleDateString("en-US", { weekday: "short" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
}

/**
 * Home from 1024px, ref E's main screen mapped to a buyer: your balance's
 * chart with recent activity under it on the left, and the SEND / RECEIVE
 * widget with your credit on the right.
 */
export function HomeDesktop() {
  const owner = useOwner();
  const plans = useData(() => getPlans(owner), [owner]);
  return (
    <>
      <h1 className="sr-only">Home</h1>
      <SignAgainNotice plans={plans.value?.plans} className="mb-8" />
      <div className="grid grid-cols-[minmax(0,1fr)_356px] gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_404px] xl:gap-x-11">
        <BalanceChart className="col-start-1 row-start-1" />
        <MoneyWidget className="col-start-2 row-span-2 row-start-1 self-start xl:sticky xl:top-6" />
        <RecentActivity className="col-start-1 row-start-2" />
      </div>
    </>
  );
}

/* ── The chart: ref E's pair header, figure, timeframes and line ───────── */

function BalanceChart({ className }: { className?: string }) {
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const profile = useData(() => getProfile(owner), [owner]);
  const { selected, balance, credit, boost } = useAccounts();
  const account: HomeAccount = selected?.id ?? "dollar";
  // Boost is offered only where the network has a vault to read it from.
  const options = ACCOUNTS.filter((a) => a.value !== "boost" || boost);
  const [frame, setFrame] = useState<Frame>("1w");
  const [type, setType] = useState<ChartType>("line");
  const minute = useNow();
  const meta = ACCOUNTS.find((a) => a.value === account)!;

  // The chart ends on the latest thing that happened, to the second.
  const now = minute && activity.value ? Math.max(minute, ...activity.value.map((a) => a.at)) : minute;
  const series: Series | null = useMemo(() => {
    if (!now) return null;
    if (account === "boost") return boost ? boostSeries(toNumber(boost.locked), frame, now) : null;
    if (account === "later") return credit && plans.value ? creditSeries(credit, plans.value.plans, frame, now) : null;
    // The line starts when the account was opened: never a week it didn't exist.
    if (!balance || !activity.value || !profile.value) return null;
    return balanceSeries(toNumber(balance.available), activity.value, frame, now, profile.value.memberSince);
  }, [account, frame, now, balance, credit, boost, activity.value, plans.value, profile.value]);

  const time = timeLabel(frame);
  const f = FRAMES[frame];
  const what = account === "dollar" ? "Your balance" : account === "later" ? "What your Pay later line can spend" : "Your Boost";
  const chip = series && !series.empty ? chipFor(series, f.suffix) : null;

  return (
    <section aria-label={`${meta.label.replace(" / USD", "")} chart`} className={cn("min-w-0", className)}>
      <PairHeader
        coins={[<PolarisCoin key="p" size={50} />, <DollarCoin key="d" size={50} />]}
        title={meta.label}
        options={options}
        value={account}
        onValueChange={(v) => setPrefs({ homeAccount: v })}
        menuLabel="Choose an account"
        trailing={<ChartTypeToggle value={type} onValueChange={setType} />}
      />

      <FigureRow
        className="mt-6"
        value={series ? <Money value={series.end} /> : undefined}
        delta={chip ? chip.delta : undefined}
        deltaSuffix={f.suffix}
        deltaLabel={chip?.label}
        deltaTitle={
          series
            ? now && series.points[0] && series.points[0].t > now - f.span + 60_000
              ? `From ${dollars(series.start)} when it opened`
              : `From ${dollars(series.start)} at the start of ${f.title}`
            : undefined
        }
        valueTitle={`${what}, now`}
        right={<TimeframeChips options={["1h", "24h", "1w", "1m"] as const} value={frame} onValueChange={setFrame} aria-label="Timeframe" />}
      />

      <div className="mt-6">
        {!series ? (
          <Skeleton shape="card" height={380} />
        ) : type === "line" ? (
          <GradientLineChart
            key={`${account}-${frame}`}
            label={`${what} over ${f.title}`}
            data={series.points}
            height={380}
            formatValue={dollars}
            formatAxis={axis}
            formatTime={time}
            formatBubbleNote={null}
            defaultIndex={restIndex(series)}
            lastLabel={f.last}
            empty={
              account === "boost" ? (
                <BoostEmpty />
              ) : (
                <p className="text-[15px] text-ui-muted">Nothing here yet.</p>
              )
            }
          />
        ) : (
          <CandlestickChart
            key={`${account}-${frame}-c`}
            label={`${what} over ${f.title}, as candles`}
            data={series.candles}
            height={380}
            formatPrice={dollars}
            formatAxis={axis}
            axisWidth={88}
            formatTime={time}
            timeAxis
            lastLabel={f.last}
            className="rounded-[20px]"
          />
        )}
      </div>
    </section>
  );
}

/**
 * The chip reads in percent, like the reference ("+3.27% today"), until the
 * frame starts near zero (a first deposit): then "+13,000%" says nothing and
 * dollars say it all ("+$1,279.70 this month"). Nothing moved: a grey "No
 * change today". FigureRow adds the suffix only to a figure (`delta` a
 * number), so a finished label passes `delta: null`.
 */
function chipFor(series: Series, suffix: string): { delta: number | null; label?: string } | null {
  // A history the moves don't explain claims no change at all.
  if (!series.explained) return null;
  const change = series.end - series.start;
  if (Math.abs(change) < 0.005) return { delta: 0, label: "No change" };
  // Started the frame at $0 (a new account): "New", as the phone and Cards say, not a percentage of nothing.
  if (series.start < 0.005 && change > 0) return { delta: null, label: `New ${suffix}` };
  if (series.deltaPct !== null && Math.abs(series.deltaPct) < 1000) return { delta: series.deltaPct };
  return { delta: null, label: `${change > 0 ? "+" : "−"}${dollars(Math.abs(change))} ${suffix}` };
}



function BoostEmpty() {
  return (
    <div className="grid justify-items-center gap-4">
      <p className="max-w-[36ch] text-[15px] text-ui-muted">Nothing locked in Boost. Dollars locked in Boost raise your Pay later line.</p>
      <PrimaryButton asChild size="sm" icon={<Sparkles />}>
        <Link href="/credit" scroll={false}>
          See your line
        </Link>
      </PrimaryButton>
    </div>
  );
}

/* ── Recent activity: ref E's borderless table with status pills ────────── */

function RecentActivity({ className }: { className?: string }) {
  const router = useRouter();
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const rows = activity.value?.slice(0, 6) ?? [];
  return (
    <section aria-label="Recent activity" className={cn("min-w-0", className)}>
      <DataTable
        caption="Recent activity"
        loading={!activity.value}
        loadingRows={4}
        rows={rows}
        rowKey={(a) => a.id}
        onRowClick={(a) => router.push(`/activity/${a.id}`, { scroll: false })}
        empty={<EmptyState size="sm" icon={<ArrowRightLeft />} title="Nothing yet" description="Payments, links and instalments show up the moment they happen." />}
        columns={activityColumns({ narrowWhen: true })}
      />
      <div className="mt-3 flex items-center justify-end gap-3">
        <SeeAll href="/activity">All activity</SeeAll>
      </div>
    </section>
  );
}

export function SeeAll({ href, children, icon }: { href: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-10 items-center gap-1.5 rounded-full px-1 text-[15px] text-ui-muted transition-colors hover:text-ui-lime-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus"
    >
      {icon}
      {children}
      <ArrowRight aria-hidden size={16} strokeWidth={1.75} />
    </Link>
  );
}

