"use client";

import {
  AdaptiveSheet,
  Button,
  CandlestickChart,
  DeltaBadge,
  DetailsList,
  GradientCard,
  IconButton,
  KeyValueGrid,
  LineArea,
  LogoMark,
  RangeTabs,
  ScreenHeader,
  SegmentedControl,
  Sheet,
  Skeleton,
  StatTile,
} from "@polaris/ui";
import { CandlestickChart as CandlesIcon, Info, LineChart } from "lucide-react";
import { useMemo, useState } from "react";
import { BringHistorySheet } from "@/components/bring-history";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { CreditProvenance } from "@/components/credit-provenance";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { ScoreDesktop } from "@/desktop/credit";
import { SuccessSheet } from "@/components/success-sheet";
import { payEarly } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { getCreditLine, getPlans, getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { relativeDay, shortDate } from "@/lib/dates";
import { usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import { ReasonLabel } from "@/components/reason-label";
import { useNow } from "@/lib/use-now";
import { scoreHistory, weeklyCandles } from "@/lib/view";

const RANGES = ["1W", "1M", "3M", "All"] as const;
type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number> = { "1W": 7, "1M": 30, "3M": 90, All: 180 };

function band(score: number): string {
  if (score >= 740) return "Excellent";
  if (score >= 670) return "Good";
  if (score >= 580) return "Fair";
  return "Building";
}

/** Credit score (full), on ref B's third screen and ref C's candles: the score week by week, the facts, Pay early and Raise limit. */
export function ScoreSheet() {
  const close = useCloseSheet();
  const owner = useOwner();
  const credit = useData(() => getCreditLine(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const profile = useData(() => getProfile(owner), [owner]);
  const [chart, setChart] = useState<"line" | "candles">("line");
  const [range, setRange] = useState<Range>("3M");
  const [why, setWhy] = useState(false);
  const [raising, setRaising] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState<{ receipt: RelayReceipt; amount: bigint; merchant: string } | null>(null);

  const days = RANGE_DAYS[range];
  const now = useNow();
  // From when the line was scored (its CRE decision), never before: the last point is today's score.
  const history = useMemo(
    () =>
      credit.value && plans.value && profile.value && now
        ? scoreHistory(credit.value, plans.value.plans, credit.value.openedAt ?? profile.value.memberSince ?? now, days, now)
        : null,
    [credit.value, plans.value, profile.value, days, now],
  );
  // No score yet: a flat zero until the first review.
  const daily = useMemo(() => (history ? (history.length ? history.map((p) => p.value) : [0, 0]) : null), [history]);
  const candles = useMemo(() => {
    if (!history || !daily || !now) return [];
    if (days <= 30) {
      return history.map((p, i) => {
        const o = daily[i - 1] ?? p.value;
        return { t: p.t, o, h: Math.max(o, p.value), l: Math.min(o, p.value), c: p.value };
      });
    }
    return weeklyCandles(daily, now);
  }, [history, daily, days, now]);

  const score = credit.value?.score;
  const start = daily?.[0];
  const change = score !== undefined && start !== undefined ? score - start : 0;
  const pct = start ? (change / start) * 100 : 0;
  const paidOnTime = plans.value?.plans.reduce((s, p) => s + p.instalments.filter((i) => i.paidAt !== null).length, 0);
  const nextTier = credit.value ? (credit.value.limit >= credit.value.openingCap ? credit.value.openingCap * 2n : credit.value.openingCap) : null;
  const next = credit.value?.nextPayment ?? null;
  const nextPlan = next ? plans.value?.plans.find((p) => p.id === next.planId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        variant="square"
        title="Credit score"
        subtitle="Updated today"
        logo={<LogoMark size={34} title="" />}
        onBack={close}
        action={<IconButton label="What moves your score" icon={<Info />} shape="square" tone="surface" onClick={() => setWhy(true)} />}
        className="-mt-2 shrink-0 px-5"
      />
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
        {score !== undefined && daily ? (
          <GradientCard
            tone="purple-chart"
            value={<span className="ui-figure">{score}</span>}
            meta={<DeltaBadge variant="chip" value={pct} amount={`${change >= 0 ? "+" : ""}${change}`} />}
            actions={
              <SegmentedControl
                variant="icon"
                aria-label="Chart type"
                value={chart}
                onValueChange={setChart}
                options={[
                  { value: "line", label: "Line", icon: <LineChart /> },
                  { value: "candles", label: "Candles", icon: <CandlesIcon /> },
                ]}
              />
            }
            chart={
              chart === "line" ? (
                <LineArea
                  key={`line-${range}`}
                  label={`Credit score, last ${days} days`}
                  data={daily}
                  height={190}
                  reference="avg"
                  interactive
                  formatValue={(v) => String(Math.round(v))}
                />
              ) : (
                <div className="px-3">
                  <CandlestickChart
                    key={`candles-${range}`}
                    label={`Credit score by ${days <= 30 ? "day" : "week"}`}
                    data={candles}
                    height={190}
                    formatPrice={(v) => String(Math.round(v))}
                    className="rounded-[18px] bg-black/20"
                  />
                </div>
              )
            }
          >
            <RangeTabs className="mt-5" aria-label="Range" ranges={[...RANGES]} value={range} onValueChange={setRange} />
          </GradientCard>
        ) : (
          <Skeleton shape="card" height={380} />
        )}

        <CreditProvenance credit={credit.value} className="self-start" />
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile value={paidOnTime ?? "–"} label="On time" />
          <StatTile value={credit.value ? usd(credit.value.limit, { trim: true }) : "–"} label="Your line" />
          <StatTile value={nextTier ? usd(nextTier, { trim: true }) : "–"} label="Next tier" tone="up" />
        </div>

        {credit.value ? (
          <KeyValueGrid
            items={[
              { label: "Band", value: band(credit.value.score) },
              { label: "Interest", value: `${credit.value.aprBps / 100}% a year` },
              { label: "Available", value: usd(credit.value.available) },
              { label: "In use", value: usd(credit.value.used) },
              { label: "Next payment", value: next ? `${usd(next.amount)} ${shortDate(next.dueAt)}` : "None" },
              { label: "Outside history", value: credit.value.historyLinked ? "Linked" : "Not yet" },
            ]}
          />
        ) : null}

        <div className="mt-1 grid grid-cols-2 gap-3">
          <Button variant="dark" shape="rounded" size="lg" disabled={!nextPlan} onClick={() => setPaying(true)}>
            Pay early
          </Button>
          <Button variant="white" shape="rounded" size="lg" onClick={() => setRaising(true)}>
            Raise limit
          </Button>
        </div>
      </Sheet.Body>

      <AdaptiveSheet open={why} onOpenChange={setWhy} snapPoints={["half"]} title="What moves your score" maxWidth={440}>
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
          <p className="text-[14px] leading-[1.45] text-ui-muted">
            Your score is worked out from facts anyone can check, and it sets your Pay later line. Paying on time moves it most.
          </p>
          <CreditProvenance credit={credit.value} size="sm" className="self-start" />
          {credit.value ? (
            <DetailsList
              size="sm"
              items={credit.value.reasons.map((r) => ({
                label: <ReasonLabel reason={r} />,
                value: <span className={r.points >= 0 ? "text-ui-up" : "text-ui-down"}>{r.points >= 0 ? `+${r.points}` : r.points}</span>,
              }))}
            />
          ) : null}
        </Sheet.Body>
      </AdaptiveSheet>

      <BringHistorySheet open={raising} onOpenChange={setRaising} credit={credit.value} />

      {nextPlan && next ? (
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
        onOpenChange={(open) => !open && setPaid(null)}
        title="Paid early."
        subtitle={paid ? `${usd(paid.amount)} to ${paid.merchant}. Your score counts it.` : undefined}
        receiptUrl={paid?.receipt.explorerUrl}
      />
    </div>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function ScoreRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet label="Credit score" snapPoints={["full"]} cold={cold} desktop={{ as: "page", content: <ScoreDesktop /> }}>
      <ScoreSheet />
    </RouteSheet>
  );
}
