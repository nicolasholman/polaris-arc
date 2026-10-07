"use client";

import {
  BalanceSummaryCard,
  CandlestickChart,
  ChartTypeToggle,
  type ChartType,
  DataTable,
  DetailsList,
  Dialog,
  FigureRow,
  GradientLineChart,
  IconSquareButton,
  Money,
  PairHeader,
  PanelCard,
  PolarisCoin,
  PrimaryButton,
  SecondaryButton,
  Skeleton,
  StatusPill,
  TableName,
  Ticks,
  TimeframeChips,
} from "@polaris/ui";
import { ArrowDownToLine, CalendarClock, Gauge, Info, Layers, Sparkles, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { MerchantAvatar } from "@/components/avatars";
import { type BoostMode, BoostSheet } from "@/components/boost-sheet";
import { BringHistorySheet } from "@/components/bring-history";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { CreditGuardLine } from "@/components/credit-guard-note";
import { CreditProvenance } from "@/components/credit-provenance";
import { SuccessSheet } from "@/components/success-sheet";
import { payEarly } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { getBoost, getCreditLine, getPlans, getProfile, type Instalment, type Plan } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { inDays, relativeDay, shortDate } from "@/lib/dates";
import { usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import { creditSeries, type Frame, FRAMES, restIndex } from "@/lib/series";
import { ReasonLabel } from "@/components/reason-label";
import { useNow } from "@/lib/use-now";
import { n, planProgress, scoreHistory, weeklyCandles } from "@/lib/view";
import { PageCoin, PageGrid, SectionTitle, SideNote } from "./bits";

const axis = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (v: number) => `$${axis(v)}`;

function band(score: number): string {
  if (score >= 740) return "Excellent";
  if (score >= 670) return "Good";
  if (score >= 580) return "Fair";
  return "Building";
}

/** What the score's next tier unlocks: the opening cap, then double it. */
function nextTier(limit: bigint, cap: bigint): bigint {
  return limit >= cap ? cap * 2n : cap;
}

/* ── Credit line ────────────────────────────────────────────────────────── */

/**
 * Credit from 1024px, a page in the frame: what your Pay later line can
 * spend (ref E's line over time), every payment coming up with its ticks,
 * and on the right your score, the next tier and Raise your limit.
 */
export function CreditDesktop() {
  const router = useRouter();
  const owner = useOwner();
  const credit = useData(() => getCreditLine(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const boost = useData(() => getBoost(owner), [owner]);
  const [frame, setFrame] = useState<Frame>("1m");
  const [raising, setRaising] = useState(false);
  const [boosting, setBoosting] = useState<BoostMode | null>(null);
  const now = useNow();

  const series = useMemo(
    () => (credit.value && plans.value && now ? creditSeries(credit.value, plans.value.plans, frame, now) : null),
    [credit.value, plans.value, now, frame],
  );
  const upcoming =
    plans.value?.plans
      .filter((p) => p.status === "active")
      .flatMap((plan) => plan.instalments.filter((i) => i.paidAt === null).map((instalment) => ({ plan, instalment })))
      .sort((a, b) => a.instalment.dueAt - b.instalment.dueAt) ?? [];
  const c = credit.value;
  const f = FRAMES[frame];
  const time = (t: string | number | Date) => {
    const d = new Date(t);
    if (frame === "1h" || frame === "24h") return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString("en-US", frame === "1w" ? { weekday: "short" } : { month: "short", day: "numeric" });
  };

  return (
    <>
      <PairHeader
        as="h1"
        className="mb-6"
        coins={[<PageCoin key="c" tone="purple"><Layers /></PageCoin>, <PolarisCoin key="p" size={50} />]}
        title="Credit line"
        trailing={<IconSquareButton label="Credit score" icon={<Gauge />} onClick={() => router.push("/credit/score", { scroll: false })} />}
      />
      <PageGrid
        main={
          <>
            <FigureRow
              caption="Pay later available"
              value={c ? <Money value={n(c.available)} /> : undefined}
              deltaLabel={c ? `of ${usd(c.limit, { trim: true })} · ${c.aprBps / 100}% APR` : undefined}
              right={<TimeframeChips options={["24h", "1w", "1m"] as const} value={frame as "24h" | "1w" | "1m"} onValueChange={setFrame} aria-label="Timeframe" />}
            />
            <div className="mt-6">
              {!series ? (
                <Skeleton shape="card" height={320} />
              ) : (
                <GradientLineChart
                  key={frame}
                  label={`What your Pay later line could spend over ${f.title}`}
                  data={series.points}
                  height={320}
                  formatValue={dollars}
                  formatAxis={axis}
                  formatTime={time}
                  formatBubbleNote={null}
                  defaultIndex={restIndex(series)}
                  lastLabel={f.last}
                />
              )}
            </div>

            <SectionTitle
              className="mt-10"
              action={
                <Link href="/plans" className="text-[15px] text-ui-muted transition-colors hover:text-ui-lime-active">
                  All plans
                </Link>
              }
            >
              Coming up
            </SectionTitle>
            <DataTable
              className="mt-3"
              caption="Payments coming up"
              loading={!plans.value}
              loadingRows={3}
              rows={upcoming.slice(0, 6)}
              rowKey={(r) => `${r.plan.id}-${r.instalment.index}`}
              onRowClick={(r) => router.push(`/plans/${r.plan.id}`, { scroll: false })}
              empty={<p className="py-4 text-[15px] text-ui-muted">Nothing due. Choose Pay in 4 at checkout.</p>}
              columns={[
                { key: "m", header: "Merchant", render: (r) => <TableName icon={<MerchantAvatar name={r.plan.merchant.name} size="xs" />} title={r.plan.merchant.name} sub={r.plan.description} /> },
                {
                  key: "which",
                  header: "Payment",
                  render: (r) => (
                    <span className="flex items-center gap-3">
                      <Ticks done={planProgress(r.plan).done} total={r.plan.instalments.length} size="sm" className="w-[88px]" />
                      <span className="ui-figure text-[13px] text-ui-muted">
                        {r.instalment.index + 1} of {r.plan.instalments.length}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "due",
                  header: "Due",
                  hideBelow: "xl",
                  render: (r) => (
                    <span className="block">
                      <span className="block">{shortDate(r.instalment.dueAt)}</span>
                      <span className="block text-[13px] text-ui-muted">{inDays(r.instalment.dueAt)}</span>
                    </span>
                  ),
                },
                { key: "amount", header: "Amount", align: "right", render: (r) => <span className="ui-figure">{usd(r.instalment.amount)}</span> },
              ]}
            />
          </>
        }
        side={
          <>
            {c && plans.value ? (
              <BalanceSummaryCard
                label="Credit score"
                value={<span className="ui-figure">{c.score}</span>}
                badge={<StatusPill tone="lime" size="sm">{band(c.score)}</StatusPill>}
                stats={[
                  { label: "Paid on time", value: plans.value.plans.reduce((s, p) => s + p.instalments.filter((i) => i.paidAt !== null).length, 0) },
                  { label: "Your line", value: usd(c.limit, { trim: true }) },
                  { label: "Next tier", value: usd(nextTier(c.limit, c.openingCap), { trim: true }) },
                ]}
              />
            ) : (
              <Skeleton shape="card" height={170} />
            )}
            <CreditProvenance credit={c} className="justify-self-start" />
            <CreditGuardLine />
            <PrimaryButton asChild size="lg" block icon={<Gauge />} className="mt-1">
              <Link href="/credit/score" scroll={false}>
                See your score
              </Link>
            </PrimaryButton>
            <SecondaryButton size="lg" block iconRight={<TrendingUp />} disabled={!c || c.historyLinked} onClick={() => setRaising(true)}>
              {c?.historyLinked ? "History linked" : "Raise your limit"}
            </SecondaryButton>
            {boost.value ? (
              <>
                <SecondaryButton size="lg" block iconRight={<Sparkles />} onClick={() => setBoosting("add")}>
                  Add to Boost
                </SecondaryButton>
                <SecondaryButton size="lg" block iconRight={<ArrowDownToLine />} onClick={() => setBoosting("takeOut")}>
                  Take out of Boost
                </SecondaryButton>
              </>
            ) : null}
            <SideNote>
              Your line grows as you pay on time. Pay in 4 is 10% a year, and each plan shows every payment and the interest before you confirm.
              {boost.value ? ` Boost: ${usd(boost.value.locked)} locked, which raises your line.` : ""}
            </SideNote>
          </>
        }
      />
      <BringHistorySheet open={raising} onOpenChange={setRaising} credit={c} />
      <BoostSheet open={boosting !== null} mode={boosting ?? "add"} onOpenChange={(o) => !o && setBoosting(null)} />
    </>
  );
}

/* ── Credit score ───────────────────────────────────────────────────────── */

// Lowercase like Home's and the reference's "1h 24h 1w 1m".
const RANGES = [
  { value: "1w", days: 7 },
  { value: "1m", days: 30 },
  { value: "3m", days: 90 },
  { value: "All", days: 180 },
] as const;
type Range = (typeof RANGES)[number]["value"];

/**
 * Credit score from 1024px, ref E's chart with Line and Candles: the score
 * day by day (or week by week), what moves it, and on the right your line,
 * Pay early and Raise your limit.
 */
export function ScoreDesktop() {
  const owner = useOwner();
  const credit = useData(() => getCreditLine(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const profile = useData(() => getProfile(owner), [owner]);
  const [type, setType] = useState<ChartType>("line");
  const [range, setRange] = useState<Range>("3m");
  const [why, setWhy] = useState(false);
  const [raising, setRaising] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState<{ receipt: RelayReceipt; amount: bigint; merchant: string } | null>(null);
  const now = useNow();
  const days = RANGES.find((r) => r.value === range)!.days;

  // From when the line was scored (its CRE decision), never before: the last point is today's score.
  const points = useMemo(() => {
    if (!credit.value || !plans.value || !profile.value || !now) return null;
    const history = scoreHistory(credit.value, plans.value.plans, credit.value.openedAt ?? profile.value.memberSince ?? now, days, now);
    // No score yet: a flat zero, which the chart shows as its empty state.
    return history.length ? history : [{ t: now - 86_400_000, value: 0 }, { t: now, value: 0 }];
  }, [credit.value, plans.value, profile.value, days, now]);
  const daily = points?.map((p) => p.value) ?? null;
  const candles = useMemo(() => {
    if (!points || !now) return [];
    const values = points.map((p) => p.value);
    if (days <= 30)
      return points.map((p, i) => {
        const o = values[i - 1] ?? p.value;
        return { t: p.t, o, h: Math.max(o, p.value), l: Math.min(o, p.value), c: p.value };
      });
    return weeklyCandles(values, now);
  }, [points, days, now]);

  const c = credit.value;
  const start = daily?.[0];
  const change = c && start !== undefined ? c.score - start : 0;
  const next = c?.nextPayment ?? null;
  const nextPlan: Plan | undefined = next ? plans.value?.plans.find((p) => p.id === next.planId) : undefined;
  const nextInstalment: Instalment | null = nextPlan ? planProgress(nextPlan).next : null;
  const time = (t: string | number | Date) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <>
      <PairHeader
        as="h1"
        className="mb-6"
        coins={[<PageCoin key="g" tone="purple"><Gauge /></PageCoin>, <PolarisCoin key="p" size={50} />]}
        title="Credit score"
        trailing={
          <div className="flex items-center gap-2">
            <IconSquareButton label="What moves your score" icon={<Info />} onClick={() => setWhy(true)} />
            <ChartTypeToggle value={type} onValueChange={setType} />
          </div>
        }
      />
      <PageGrid
        main={
          <>
            <FigureRow
              caption={c ? `${band(c.score)}, updated today` : "Updated today"}
              value={c ? <span className="ui-figure">{c.score}</span> : undefined}
              delta={c && start ? (change / start) * 100 : undefined}
              deltaLabel={c && start !== undefined ? `${change >= 0 ? "+" : "−"}${Math.abs(change)} points` : undefined}
              deltaTitle={`Over the last ${days} days`}
              right={<TimeframeChips options={RANGES.map((r) => r.value)} value={range} onValueChange={setRange} aria-label="Range" />}
            />
            <div className="mt-6">
              {!points ? (
                <Skeleton shape="card" height={360} />
              ) : type === "line" ? (
                <GradientLineChart
                  key={`line-${range}`}
                  label={`Credit score, last ${days} days`}
                  data={points}
                  height={360}
                  formatValue={(v) => String(Math.round(v))}
                  formatAxis={(v) => String(Math.round(v))}
                  formatTime={time}
                  formatBubbleNote={null}
                  defaultIndex={points.length - 1}
                  lastLabel="Today"
                  empty={<p className="text-[15px] text-ui-muted">No score yet. Raise your limit and your first one lands here.</p>}
                />
              ) : (
                <CandlestickChart
                  key={`candles-${range}`}
                  label={`Credit score by ${days <= 30 ? "day" : "week"}`}
                  data={candles}
                  height={360}
                  formatPrice={(v) => String(Math.round(v))}
                  formatAxis={(v) => String(Math.round(v))}
                  formatTime={time}
                  timeAxis
                  lastLabel="Today"
                  className="rounded-[20px]"
                />
              )}
            </div>

            <SectionTitle className="mt-10" action={<CreditProvenance credit={c} size="sm" />}>
              What moves it
            </SectionTitle>
            <DataTable
              className="mt-3"
              caption="What moves your score"
              loading={!c}
              loadingRows={3}
              rows={c?.reasons ?? []}
              rowKey={(r) => r.label}
              columns={[
                { key: "fact", header: "Fact", render: (r) => <span className="text-[16px]"><ReasonLabel reason={r} /></span> },
                {
                  key: "points",
                  header: "Points",
                  align: "right",
                  render: (r) => (
                    <StatusPill tone={r.points >= 0 ? "lime" : "red"} size="sm">
                      {r.points >= 0 ? `+${r.points}` : r.points}
                    </StatusPill>
                  ),
                },
              ]}
            />
          </>
        }
        side={
          <>
            {c ? (
              <BalanceSummaryCard
                label="Your Pay later line"
                value={<Money value={n(c.limit)} />}
                badge={<StatusPill tone="lime" size="sm">{c.aprBps / 100}% APR</StatusPill>}
                stats={[
                  { label: "Available", value: usd(c.available) },
                  { label: "In use", value: usd(c.used) },
                  { label: "Next tier", value: usd(nextTier(c.limit, c.openingCap), { trim: true }) },
                ]}
              />
            ) : (
              <Skeleton shape="card" height={170} />
            )}
            <PanelCard padding="md" title="Next payment">
              <DetailsList
                className="mt-3"
                size="sm"
                items={[
                  { label: "Amount", value: !c ? "…" : next ? usd(next.amount) : "None" },
                  { label: "To", value: !c ? "…" : (next?.merchant ?? "Nobody") },
                  { label: "Due", value: !c ? "…" : next ? `${shortDate(next.dueAt)}, ${inDays(next.dueAt)}` : "Nothing due" },
                  { label: "Outside history", value: !c ? "…" : c.historyLinked ? "Linked" : "Not yet" },
                ]}
              />
            </PanelCard>
            <PrimaryButton size="lg" block icon={<CalendarClock />} disabled={!nextPlan} onClick={() => setPaying(true)} className="mt-1">
              {next ? `Pay ${usd(next.amount)} early` : c ? "Nothing to pay early" : "Pay early"}
            </PrimaryButton>
            <SecondaryButton size="lg" block iconRight={<TrendingUp />} disabled={!c || c.historyLinked} onClick={() => setRaising(true)}>
              {c?.historyLinked ? "History linked" : "Raise your limit"}
            </SecondaryButton>
            <SideNote>Your score is worked out from facts anyone can check, and it sets your line. Paying on time moves it most.</SideNote>
          </>
        }
      />

      <Dialog open={why} onOpenChange={setWhy} size="sm" title="What moves your score" description="Facts anyone can check. Paying on time moves it most.">
        <Dialog.Body>
          <CreditProvenance credit={c} size="sm" className="mb-3" />
          {c ? (
            <DetailsList
              size="sm"
              items={c.reasons.map((r) => ({
                label: <ReasonLabel reason={r} />,
                value: <span className={r.points >= 0 ? "text-ui-up" : "text-ui-down"}>{r.points >= 0 ? `+${r.points}` : r.points}</span>,
              }))}
            />
          ) : null}
        </Dialog.Body>
      </Dialog>
      <BringHistorySheet open={raising} onOpenChange={setRaising} credit={c} />
      {nextPlan && next && nextInstalment ? (
        <ConfirmSheet
          open={paying}
          onOpenChange={setPaying}
          title={`Pay ${usd(next.amount)} early`}
          summary={`Your next payment to ${nextPlan.merchant.name}, due ${relativeDay(next.dueAt)}. Paying early costs nothing extra.`}
          busyLabel="Paying…"
          onAccount={async (signer) => {
            const receipt = await payEarly(signer, nextPlan);
            setPaid({ receipt, amount: next.amount, merchant: nextPlan.merchant.name });
          }}
        />
      ) : null}
      <SuccessSheet
        open={paid !== null}
        onOpenChange={(o) => !o && setPaid(null)}
        title="Paid early."
        subtitle={paid ? `${usd(paid.amount)} to ${paid.merchant}. Your score counts it.` : undefined}
        receiptUrl={paid?.receipt.explorerUrl}
      />
    </>
  );
}
