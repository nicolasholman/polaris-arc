"use client";

import {
  BarChart,
  CandlestickChart,
  ChartTypeToggle,
  DataTable,
  DeltaChip,
  DollarCoin,
  DonutChart,
  Money,
  PrimaryButton,
  SecondaryButton,
  GradientLineChart,
  PairHeader,
  PolarisCoin,
  ProgressLegend,
  Skeleton,
  StatusPill,
  TimeframeChips,
  cn,
  type ChartType,
  type StatusPillTone,
} from "@polaris/ui";
import { ArrowRight, BadgeCheck, Check, Layers, Link2, ShieldCheck, Users, Workflow } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { MoneyWidget } from "@/components/dashboard/money-widget";
import { MODE_COLOR, PaymentName, paymentPill } from "@/components/dashboard/payment-bits";
import { LoadError, Panel, PanelEmpty, SeeAll, StaleNotice, useNow } from "@/components/dashboard/common";
import { RegistrationNotice } from "@/components/dashboard/registration";
import { customersThisWeek, salesByMode, salesSeries, SERIES_FRAMES, type SeriesFrame } from "@/lib/data/analytics";
import { formatAgo, MODE_LABEL, money, shortAddress } from "@/lib/data/format";
import { getCollectionsRun, getIndexedEvents, getUnderwritingReasons } from "@/lib/data/insights";
import type { Overview, PayMode, Payment, Plan } from "@/lib/data/types";
import { useMerchant } from "@/lib/merchant-context";
import { LIVE_REFRESH_MS, useQuery, type QueryState } from "@/lib/session";

/**
 * The Overview is ref E's main screen, mapped to Polaris: the sales chart
 * with the recent payments under it on the left, the money widget (withdraw,
 * request) on the right, and the rest of the business in a row of cards.
 */
export function OverviewView() {
  const { merchant } = useMerchant();
  // A new payment is on screen within seconds (3 s under demo:local, 10 s in production).
  const overview = useQuery((d) => d.getOverview(), { refreshMs: LIVE_REFRESH_MS });
  const payments = useQuery((d) => d.listPayments(), { refreshMs: LIVE_REFRESH_MS });
  const plans = useQuery((d) => d.listPlans(), { refreshMs: LIVE_REFRESH_MS });

  const list = payments.data;
  const empty = overview.data !== undefined && list !== undefined && list.length === 0 && overview.data.balanceCents === 0;

  return (
    <>
      <h1 className="sr-only">Overview, {merchant.businessName}</h1>
      <StaleNotice queries={[overview, payments, plans] as QueryState<unknown>[]} />
      {/* When nothing has sold, the chart and the checklist below say what to do. */}
      <RegistrationNotice className="mb-6" />

      {/* Ref E: the chart and the table on the left, the widget on the right. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_356px] xl:grid-cols-[minmax(0,1fr)_404px] xl:gap-x-11">
        <SalesChart payments={payments} empty={empty} className="lg:col-start-1 lg:row-start-1" />
        <MoneyWidget payments={list} className="lg:col-start-2 lg:row-span-2 lg:row-start-1" />
        <RecentPayments payments={payments} className="lg:col-start-1 lg:row-start-2" />
      </div>

      {empty ? (
        // Nothing has sold yet: one checklist instead of five empty cards.
        <GettingStarted />
      ) : (
        <>
          <h2 className="mt-14 text-[22px] leading-tight font-medium tracking-[-0.02em] sm:mt-16">Your business this month</h2>
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <CustomersPanel payments={list} error={payments.error && !list ? payments : null} />
            <ModesPanel payments={list} />
            <ExposurePanel overview={overview.data} plans={plans.data} className="md:col-span-2 xl:col-span-1" />
            <CollectionsPanel plans={plans.data} collector={overview.data?.collector} />
            <EnvioFeed overview={overview} className="xl:col-span-2" />
          </div>
        </>
      )}
    </>
  );
}

/* ── The big chart: ref E's pair header, figure, timeframes and line ────── */

type Metric = "sales" | "later" | "subscribe";

const METRICS: { value: Metric; label: string; description: string; mode?: PayMode }[] = [
  { value: "sales", label: "Sales / USD", description: "Every paid payment" },
  { value: "later", label: "Pay in 4 / USD", description: "Paid to you in full at checkout", mode: "later" },
  { value: "subscribe", label: "Subscriptions / USD", description: "Every subscription charge", mode: "subscribe" },
];

const FRAME_SUFFIX: Record<SeriesFrame, string> = { "1h": "this hour", "24h": "today", "1w": "this week", "1m": "this month" };
const FRAME_TITLE: Record<SeriesFrame, string> = { "1h": "the last hour", "24h": "the last 24 hours", "1w": "the last 7 days", "1m": "the last 30 days" };

const axis = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (v: number) => `$${axis(v)}`;

function timeLabel(frame: SeriesFrame) {
  return (t: string | number | Date) => {
    const d = new Date(t);
    if (frame === "1h" || frame === "24h") return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (frame === "1w") return d.toLocaleDateString("en-US", { weekday: "short", hour: "numeric" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
}

function SalesChart({ payments, empty, className }: { payments: QueryState<Payment[]>; empty: boolean; className?: string }) {
  const [metric, setMetric] = useState<Metric>("sales");
  const [frame, setFrame] = useState<SeriesFrame>("24h");
  const [type, setType] = useState<ChartType>("line");
  const now = useNow(60_000);
  const m = METRICS.find((x) => x.value === metric)!;
  const list = payments.data;
  const series = useMemo(() => (list ? salesSeries(list, frame, { mode: m.mode, now }) : null), [list, frame, m.mode, now]);
  const time = timeLabel(frame);
  const what = `${m.label.replace(" / USD", "")} in dollars over ${FRAME_TITLE[frame]}`;
  const described = `${what}, each point the running total since the start`;

  return (
    <section aria-label={`${m.label.replace(" / USD", "")} chart`} className={cn("min-w-0", className)}>
      <PairHeader
        coins={[<PolarisCoin key="p" size={50} />, <DollarCoin key="d" size={50} />]}
        title={m.label}
        options={METRICS.map(({ value, label, description }) => ({ value, label, description }))}
        value={metric}
        onValueChange={setMetric}
        menuLabel="Choose what to chart"
        trailing={<ChartTypeToggle value={type} onValueChange={setType} />}
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {series ? (
            <>
              <span className="ui-figure text-[36px] leading-none font-medium tracking-[-0.035em] sm:text-[44px]" title={`Paid over ${FRAME_TITLE[frame]}`}>
                <Money value={series.grossCents / 100} />
              </span>
              <DeltaChip
                value={series.deltaPct}
                suffix={series.deltaPct === null ? undefined : FRAME_SUFFIX[frame]}
                label={series.deltaPct === null ? (series.count ? "New" : "No sales yet") : undefined}
                title={series.deltaPct === null ? "Nothing to compare with yet" : SERIES_FRAMES[frame].versus}
              />
            </>
          ) : (
            <Skeleton width={260} height={44} />
          )}
        </div>
        <TimeframeChips options={["1h", "24h", "1w", "1m"] as const} value={frame} onValueChange={setFrame} aria-label="Timeframe" />
      </div>

      <div className="mt-6">
        {payments.error && !list ? (
          <div className="grid h-[380px] place-items-center">
            <LoadError query={payments as QueryState<unknown>} title="We couldn't load your sales" />
          </div>
        ) : !series ? (
          <Skeleton shape="card" height={380} />
        ) : type === "line" ? (
          <GradientLineChart
            key={`${metric}-${frame}`}
            label={described}
            data={series.points}
            height={380}
            formatValue={dollars}
            formatAxis={axis}
            formatTime={time}
            formatBubbleNote={null}
            lastLabel={frame === "1h" || frame === "24h" ? "Now" : "Today"}
            empty={
              <div className="grid justify-items-center gap-4">
                <p className="text-[15px] text-ui-muted">
                  {empty ? "No sales yet. Your first one draws this line." : `No ${metric === "sales" ? "sales" : m.label.replace(" / USD", "")} in ${FRAME_TITLE[frame]}`}
                </p>
                {empty ? (
                  <PrimaryButton asChild size="sm" icon={<Link2 />}>
                    <Link href="/dashboard/links?new=1">New payment link</Link>
                  </PrimaryButton>
                ) : null}
              </div>
            }
          />
        ) : (
          <CandlestickChart
            key={`${metric}-${frame}-c`}
            label={`${what}, as candles of the rolling ${SERIES_FRAMES[frame].windowLabel} total`}
            data={series.candles}
            height={380}
            formatPrice={(v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`)}
            formatTime={time}
            className="rounded-[20px]"
          />
        )}
      </div>
    </section>
  );
}

/* ── Recent payments: ref E's borderless table with status pills ────────── */

function RecentPayments({ payments, className }: { payments: QueryState<Payment[]>; className?: string }) {
  const router = useRouter();
  const now = useNow(30_000);
  const rows = payments.data?.slice(0, 5) ?? [];
  return (
    <section aria-label="Recent payments" className={cn("min-w-0", className)}>
      <DataTable
        caption="Recent payments"
        loading={!payments.data && !payments.error}
        loadingRows={4}
        rows={rows}
        rowKey={(p) => p.id}
        onRowClick={(p) => router.push(`/dashboard/payments?open=${encodeURIComponent(p.id)}`)}
        empty={<PanelEmpty icon={<Layers />} title="No payments yet" description="Your latest payments land here the second they settle." />}
        columns={[
          { key: "customer", header: "Customer", render: (p) => <PaymentName p={p} sub="fold" /> },
          { key: "item", header: "Item", hideBelow: "xl", render: (p) => <span className="block max-w-[220px] truncate" title={p.description}>{p.description}</span> },
          {
            key: "amount",
            header: "Amount",
            render: (p) => (
              <span className="flex flex-col">
                <span className={cn("ui-figure", p.status === "failed" && "text-ui-muted line-through")}>{money(p.amountCents)}</span>
                {/* Below sm the Net column folds in here. */}
                <span className="ui-figure text-[13px] text-ui-muted sm:hidden">{p.status === "failed" ? "Failed" : `Net ${money(p.netCents)}`}</span>
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            hideBelow: "sm",
            render: (p) => {
              const pill = paymentPill(p);
              return <StatusPill tone={pill.tone}>{pill.text}</StatusPill>;
            },
          },
          {
            key: "net",
            header: "Net",
            hideBelow: "sm",
            render: (p) => (
              <span className="ui-figure" title={formatAgo(p.createdAt, now)}>
                {p.status === "failed" ? "$0.00" : money(p.netCents)}
              </span>
            ),
          },
        ]}
      />
      <div className="mt-3 flex items-center justify-end gap-3">
        <Link
          href="/dashboard/payments"
          className="inline-flex h-10 items-center gap-1.5 rounded-full px-1 text-[15px] text-ui-muted transition-colors hover:text-ui-lime-active"
        >
          All payments
          <ArrowRight aria-hidden size={16} strokeWidth={1.75} />
        </Link>
      </div>
    </section>
  );
}

/* ── Customers this week (bars) ─────────────────────────────────────────── */

function CustomersPanel({ payments, error }: { payments?: Payment[]; error: QueryState<Payment[]> | null }) {
  const week = useMemo(() => (payments ? customersThisWeek(payments) : null), [payments]);
  return (
    <Panel title="Customers this week" action={<SeeAll href="/dashboard/payments" />}>
      {error ? (
        <LoadError query={error as QueryState<unknown>} />
      ) : !week ? (
        <Skeleton shape="tile" height={260} className="mt-5" />
      ) : week.total === 0 ? (
        <PanelEmpty icon={<Users />} title="No buyers yet this week" description="Each bar is the people who paid you that day." />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="ui-figure text-[34px] leading-none font-medium tracking-[-0.03em]">{week.total}</span>
            {week.deltaPct === null ? (
              <DeltaChip value={null} label="New this week" size="sm" />
            ) : (
              <DeltaChip value={week.deltaPct} suffix="vs last week" size="sm" decimals={1} />
            )}
          </div>
          <FillHeight min={236} className="mt-6">
            {(h) => (
              <BarChart
                label="Buyers per day this week"
                data={week.days.map((d) => ({ label: d.label, value: d.value }))}
                defaultSelected={week.days.findIndex((d) => d.today)}
                height={h}
                formatValue={(v) => `${v} ${v === 1 ? "buyer" : "buyers"}`}
                formatTick={(v) => String(Math.round(v))}
              />
            )}
          </FillHeight>
        </>
      )}
    </Panel>
  );
}

/**
 * A chart that fills the rest of its card: the card stretches to its row's
 * tallest, and this measures the room left (at least `min` px, less the
 * labels under the bars). Absolutely positioned inside, so the chart never
 * props the card open and the row can shrink again.
 */
function FillHeight({ min, className, children }: { min: number; className?: string; children: (height: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(min);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(Math.max(min, Math.floor(el.getBoundingClientRect().height) - BAR_LABELS)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return (
    <div ref={ref} className={cn("relative flex-1", className)} style={{ minHeight: min + BAR_LABELS }}>
      <div className="absolute inset-x-0 top-0">{children(height)}</div>
    </div>
  );
}

/** The day labels under BarChart's bars. */
const BAR_LABELS = 34;

/* ── Getting started: until the first sale ──────────────────────────────── */

function GettingStarted() {
  const links = useQuery((d) => d.listLinks());
  const hasLink = (links.data?.length ?? 0) > 0;
  const steps = [
    {
      title: "Create a payment link",
      body: "An amount and what it's for. Buyers choose Pay now, Pay in 4 or a subscription.",
      done: hasLink,
      action: (
        <PrimaryButton asChild size="sm" icon={<Link2 />}>
          <Link href="/dashboard/links?new=1">New payment link</Link>
        </PrimaryButton>
      ),
    },
    {
      title: "Share it",
      body: "Send the link, show its QR code, or put the checkout on your site with the SDK.",
      done: false,
      action: (
        <SecondaryButton asChild size="sm" iconRight={<ArrowRight />}>
          <Link href={hasLink ? "/dashboard/links" : "/dashboard/developers"}>{hasLink ? "Your links" : "The SDK"}</Link>
        </SecondaryButton>
      ),
    },
    {
      title: "Your first payment",
      body: "It lands in your balance within a second of the buyer confirming, in full, even on Pay in 4.",
      done: false,
      action: null,
    },
  ];
  return (
    <section aria-labelledby="getting-started" className="mt-14 sm:mt-16">
      <h2 id="getting-started" className="text-[22px] leading-tight font-medium tracking-[-0.02em]">
        Getting started
      </h2>
      <ol className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex flex-col rounded-ui-panel border border-ui-hairline-strong p-5 sm:p-6">
            <span
              aria-hidden
              className={cn(
                "grid size-9 place-items-center rounded-full text-[15px] font-semibold",
                step.done ? "bg-ui-lime-button text-[#121418]" : "bg-ui-surface-1 text-ui-muted",
              )}
            >
              {step.done ? <Check size={17} strokeWidth={2.5} /> : i + 1}
            </span>
            <h3 className="mt-4 text-[18px] leading-tight font-medium tracking-[-0.015em]">
              {step.title}
              {step.done ? <span className="sr-only"> (done)</span> : null}
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-ui-muted">{step.body}</p>
            {step.action && !step.done ? <div className="mt-auto pt-5">{step.action}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ── Sales by mode (donut) ──────────────────────────────────────────────── */

function ModesPanel({ payments }: { payments?: Payment[] }) {
  const split = useMemo(() => (payments ? salesByMode(payments, { days: 30 }) : null), [payments]);
  const total = split?.reduce((s, m) => s + m.cents, 0) ?? 0;
  return (
    <Panel title="Sales by mode" subtitle={split ? `Last 30 days · ${money(total)}` : "Last 30 days"}>
      {!split ? (
        <Skeleton shape="tile" height={280} className="mt-5" />
      ) : total === 0 ? (
        <PanelEmpty icon={<Layers />} title="No sales in the last 30 days" description="Pay now, Pay in 4 and subscriptions split here once buyers pay." />
      ) : (
        <div className="mt-5 flex flex-1 flex-col items-center gap-6">
          <DonutChart
            label="Sales by payment mode, last 30 days"
            size={212}
            gap={4}
            data={split.map((m) => ({ label: MODE_LABEL[m.mode], value: m.cents / 100, color: MODE_COLOR[m.mode] }))}
            formatValue={(v) => `$${Math.round(v).toLocaleString("en-US")}`}
            showTags={false}
            centerLabel="Total"
            centerValue={`$${Math.round(total / 100).toLocaleString("en-US")}`}
            className="my-auto shrink-0"
          />
          <ProgressLegend className="w-full min-w-0" items={split.map((m) => ({ label: MODE_LABEL[m.mode], value: m.share, color: MODE_COLOR[m.mode] }))} />
        </div>
      )}
    </Panel>
  );
}

/* ── Credit exposure, with the reasons behind the lines (Nansen) ────────── */

function ExposurePanel({ overview, plans, className }: { overview?: Overview; plans?: Plan[]; className?: string }) {
  const e = overview?.exposure;
  const insights = overview?.insights;
  const reasons = useMemo(() => (plans ? getUnderwritingReasons({ insights }) : null), [plans, insights]);
  return (
    <Panel title="Credit exposure" subtitle="Pay in 4 plans still collecting" action={<SeeAll href="/dashboard/plans">Ledger</SeeAll>} className={className}>
      {!e || !reasons ? (
        <Skeleton shape="tile" height={260} className="mt-5" />
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <Figure label="Outstanding" value={money(e.outstandingCents)} note={`${e.collectingPlans + e.atRiskPlans} open plans`} />
            <Figure
              label="At risk"
              value={money(e.atRiskCents)}
              note={e.atRiskPlans ? `${e.atRiskPlans} retrying` : "Nothing retrying"}
              tone={e.atRiskPlans ? "warn" : undefined}
            />
            <Figure label="Collected this week" value={money(e.collectedThisWeekCents)} />
            <Figure label="On time" value={e.collectionRate === null ? "Not yet" : `${e.collectionRate.toFixed(1)}%`} note={e.collectionRate === null ? "Nothing has come due" : undefined} />
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-ui-muted">
            You were paid in full when each plan opened. What buyers still owe is collected by Polaris, and the risk is ours.
          </p>
          <div className="mt-4 border-t border-ui-hairline-strong pt-4">
            <p className="flex items-center gap-2 text-[14px] font-medium">
              <ShieldCheck aria-hidden size={16} strokeWidth={1.75} className="text-ui-lime-text" />
              Why your buyers got credit
            </p>
            {reasons.source === "not_connected" ? (
              <p className="mt-2 text-[13px] leading-relaxed text-ui-muted">{reasons.reason}</p>
            ) : (
              <ul className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2">
                {reasons.data.reasons.slice(0, 4).map((r) => (
                  <li key={r.text} className="flex items-center justify-between gap-3 text-[13.5px]">
                    <span className="min-w-0 truncate">{r.text}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {r.source ? <span className="text-[12px] text-ui-muted">{r.source}</span> : null}
                      <StatusPill tone="lime" size="sm" className="ui-figure h-6 px-2 text-[12px]">
                        +{r.points}
                      </StatusPill>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

function Figure({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "warn" }) {
  return (
    <div className="rounded-[18px] bg-ui-surface-1 px-4 py-3">
      <p className="text-[13px] text-ui-muted">{label}</p>
      <p className={cn("ui-figure mt-1 text-[19px] leading-tight font-medium tracking-[-0.01em]", tone === "warn" && "text-ui-pill-amber-text")}>{value}</p>
      {note ? <p className="mt-0.5 text-[12px] text-ui-muted">{note}</p> : null}
    </div>
  );
}

/* ── Collections: the Chainlink CRE workflow's last and next run ────────── */

function CollectionsPanel({ plans, collector }: { plans?: Plan[]; collector?: Overview["collector"] }) {
  const now = useNow(1000);
  const run = useMemo(() => (plans ? getCollectionsRun({ plans, collector }) : null), [plans, collector]);
  // The workflow's real report time, and the next minute's run after it.
  const nextAt = run?.source === "live" ? Date.parse(run.data.nextRunAt) : null;
  const lastAt = run?.source === "live" ? Date.parse(run.data.lastRun.at) : null;
  const ago = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : formatAgo(new Date(now - ms).toISOString(), now));
  return (
    <Panel title="Collections" subtitle="Chainlink CRE workflow" action={<SeeAll href="/dashboard/chainlink">Chainlink</SeeAll>}>
      {!run ? (
        <Skeleton shape="tile" height={260} className="mt-5" />
      ) : run.source === "not_connected" ? (
        <PanelEmpty icon={<Workflow />} title="No collections run yet" description={run.reason} />
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <Figure label="Last run" value={lastAt ? ago(now - lastAt) : "—"} />
            <Figure
              label="Next run"
              value={nextAt ? (nextAt > now ? `in ${Math.round((nextAt - now) / 1000)} s` : run.data.state === "running" ? "due now" : "overdue") : "—"}
            />
          </div>
          <dl className="mt-4 grid gap-2.5 text-[14px]">
            <Line label="Schedule" value={`${run.data.schedule} · ${run.data.workflow}`} />
            <Line label="Plans checked" value={String(run.data.lastRun.checked)} />
            {run.data.lastRun.collected !== null ? (
              <Line label="Collected last run" value={`${run.data.lastRun.collected} · ${money(run.data.lastRun.collectedCents ?? 0)}`} />
            ) : (
              <Line label="Workflow" value={run.data.state === "running" ? "Reporting" : run.data.state === "degraded" ? "Late" : "Stopped"} />
            )}
            <Line label="Retrying" value={String(run.data.lastRun.retrying)} />
          </dl>
          {run.data.lastRun.skipped.length ? <p className="mt-3 text-[13px] leading-snug text-ui-muted">{run.data.lastRun.skipped[0]!.reason}.</p> : null}
          {run.data.history.length ? (
            <>
              <p className="mt-4 text-[12px] text-ui-muted">Instalments collected, last 12 runs</p>
              <div className="mt-2 flex h-10 items-end justify-between" aria-hidden>
                {run.data.history.map((n, i) => (
                  <span key={i} className={cn("w-2 flex-none rounded-full", n ? "bg-ui-lime-button" : "bg-ui-surface-2")} style={{ height: `${n ? 40 + n * 30 : 20}%` }} />
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-ui-hairline pb-2.5 last:border-0 last:pb-0">
      <dt className="text-ui-muted">{label}</dt>
      <dd className="ui-figure truncate text-right">{value}</dd>
    </div>
  );
}

/* ── Indexed by Envio: the live event feed ──────────────────────────────── */

const EVENT_LABEL: Record<string, string> = {
  "payment.succeeded": "Payment",
  "plan.opened": "Plan opened",
  "installment.collected": "Instalment collected",
  "installment.failed": "Instalment failed",
  "plan.completed": "Plan completed",
  "plan.liquidated": "Plan closed",
  "subscription.charged": "Subscription",
  "subscription.canceled": "Subscription canceled",
  "payout.paid": "Payout",
};

function eventTone(type: string): StatusPillTone {
  if (type.endsWith("failed") || type.endsWith("liquidated")) return "amber";
  if (type.startsWith("plan") || type.startsWith("installment")) return "purple";
  if (type.startsWith("subscription")) return "teal";
  return "lime";
}

function EnvioFeed({ overview, className }: { overview: QueryState<Overview>; className?: string }) {
  const now = useNow(10_000);
  const insights = overview.data?.insights;
  const feed = useMemo(() => (overview.data ? getIndexedEvents({ insights }) : null), [overview.data, insights]);
  const viaSync = feed?.source === "live" && feed.via === "chain-sync";
  const indexerError = insights?.indexer.source === "envio-error";
  const events = feed?.source === "live" ? feed.data.slice(0, 6) : [];
  return (
    <Panel
      title="Indexed by Envio"
      subtitle={viaSync ? "Envio isn't connected: from this server's chain sync" : "Chain events as they settle"}
      className={className}
      action={
        // "Streaming" only when it is.
        viaSync ? (
          <StatusPill tone="neutral" size="sm">
            Chain sync
          </StatusPill>
        ) : feed?.source === "live" ? (
          <StatusPill tone="lime" size="sm" icon={<span className="block size-2 rounded-full bg-current" />}>
            Streaming
          </StatusPill>
        ) : null
      }
    >
      {!feed ? (
        <Skeleton shape="tile" height={260} className="mt-5" />
      ) : feed.source === "not_connected" ? (
        <PanelEmpty icon={<BadgeCheck />} title={indexerError ? "The indexer didn't answer" : "Indexer not configured"} description={feed.reason} />
      ) : events.length === 0 ? (
        <PanelEmpty icon={<BadgeCheck />} title="No chain events yet" description="Payments, plans and payouts appear here as the indexer sees them on Monad." />
      ) : (
        <ul className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)]">
          <AnimatePresence initial={false}>
            {events.map((ev) => (
              <motion.li
                key={ev.id}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-ui-hairline py-3 last:border-0 sm:grid-cols-[150px_minmax(0,1fr)_auto]"
              >
                <span className="hidden sm:block">
                  <StatusPill tone={eventTone(ev.type)} size="sm">
                    {EVENT_LABEL[ev.type] ?? ev.type}
                  </StatusPill>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium">
                    <span className="sm:hidden">{EVENT_LABEL[ev.type] ?? ev.type} · </span>
                    {ev.title}
                  </span>
                  <span className="ui-figure block truncate text-[12.5px] text-ui-muted">
                    {[ev.block > 0 ? `Block ${ev.block.toLocaleString("en-US")}` : null, ev.txHash ? shortAddress(ev.txHash, 6, 4) : null, formatAgo(ev.at, now)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="ui-figure shrink-0 text-[15px] font-medium">{money(ev.amountCents)}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  );
}
