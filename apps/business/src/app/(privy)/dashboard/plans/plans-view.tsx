"use client";

import {
  BalanceSummaryCard,
  DataTable,
  DetailsList,
  Drawer,
  EmptyState,
  KeyValueGrid,
  Money,
  Notice,
  PanelCard,
  SecondaryButton,
  Skeleton,
  StatusPill,
  TableName,
  Ticks,
  TimeframeChips,
  cn,
  type TableColumn,
} from "@polaris/ui";
import { CalendarClock, Check, Clock, RotateCcw, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Address, CopyAction, DrawerActions, ExplorerAction, PlanStateBadge } from "@/components/dashboard/bits";
import { DataModeNotice, LoadError, StaleNotice } from "@/components/dashboard/common";
import { FigureRow, PageCoin, PageHead } from "@/components/dashboard/page-head";
import { BuyerCoin, ModeCoin } from "@/components/dashboard/payment-bits";
import { explorerAddress } from "@/lib/chain";
import { formatDate, formatDue, money, payInFourQuote, PLAN_INTERVAL_DAYS, shortAddress } from "@/lib/data/format";
import type { Plan, PlanFilter } from "@/lib/data/types";
import { LIVE_REFRESH_MS, useQuery, type QueryState } from "@/lib/session";

const DAY = 86_400_000;
/** Plans shown at a time; "Show more" adds another page. */
const PAGE = 25;
/** The worked example: $200 at 10% APR over 28 days is 4 × $50.38. */
const EXAMPLE = payInFourQuote(200_00);

export function PlansView() {
  const plans = useQuery((d) => d.listPlans(), { refreshMs: LIVE_REFRESH_MS });
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [filter, setFilter] = useState<PlanFilter>("all");
  const [limit, setLimit] = useState(PAGE);

  const list = plans.data;
  const openId = params.get("open");
  const openOrder = params.get("order");
  const open = list?.find((p) => (openId ? p.id === openId : openOrder ? p.orderId === openOrder : false)) ?? null;
  const setOpen = (p: Plan | null) => {
    const next = new URLSearchParams(params.toString());
    next.delete("order");
    if (p) next.set("open", p.id);
    else next.delete("open");
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  const counts = useMemo(() => {
    const c = { all: 0, collecting: 0, dunning: 0, closed: 0 };
    for (const p of list ?? []) {
      c.all += 1;
      if (p.state === "collecting") c.collecting += 1;
      else if (p.state === "dunning") c.dunning += 1;
      else c.closed += 1;
    }
    return c;
  }, [list]);

  const filtered = (list ?? []).filter((p) =>
    filter === "all" ? true : filter === "closed" ? p.state === "repaid" || p.state === "written_off" : p.state === filter,
  );
  // The drawer finds an open plan in the whole list, whatever page is showing.
  const shown = filtered.slice(0, limit);
  const s = useSummary(list);

  return (
    <>
      <PageHead
        title="Pay in 4"
        coins={[
          <PageCoin key="4" tone="purple">
            <span className="text-[24px] leading-none font-bold">4</span>
          </PageCoin>,
          <PageCoin key="d" tone="lime">
            <span className="text-[26px] font-bold">$</span>
          </PageCoin>,
        ]}
      />
      <StaleNotice queries={[plans as QueryState<unknown>]} />
      <DataModeNotice empty={list !== undefined && list.length === 0} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-11 gap-y-10 xl:grid-cols-[minmax(0,1fr)_404px]">
        <section aria-label="The Pay in 4 ledger" className="min-w-0">
          <FigureRow
            caption="Still owed by buyers"
            value={s ? <Money value={s.outstanding / 100} /> : undefined}
            deltaLabel={s ? `${s.open} open ${s.open === 1 ? "plan" : "plans"}` : undefined}
            right={
              <TimeframeChips<PlanFilter>
                aria-label="Filter plans"
                options={[
                  { value: "all", label: `All ${counts.all}` },
                  { value: "collecting", label: `Collecting ${counts.collecting}` },
                  { value: "dunning", label: `Retrying ${counts.dunning}` },
                  { value: "closed", label: `Closed ${counts.closed}` },
                ]}
                value={filter}
                onValueChange={(v) => {
                  setFilter(v);
                  setLimit(PAGE);
                }}
              />
            }
          />
          <p className="mt-3 max-w-[600px] text-[15px] leading-relaxed text-ui-muted">
            Every plan your buyers opened. You were paid in full when each one opened; Polaris collects the four payments and carries the risk.
          </p>

          <div className="mt-6">
            {plans.error && !list ? (
              <LoadError query={plans as QueryState<unknown>} title="We couldn't load the ledger" />
            ) : list && filtered.length === 0 ? (
              <EmptyState
                icon={<CalendarClock />}
                title={list.length ? "No plans here" : "No Pay in 4 plans yet"}
                description={
                  list.length ? "No plans match this filter." : "When a buyer chooses Pay in 4 on one of your links, the plan appears here with its four payments."
                }
              />
            ) : (
              <DataTable
                caption="Pay in 4 plans"
                loading={!list}
                loadingRows={8}
                columns={COLUMNS}
                rows={shown}
                rowKey={(p) => p.id}
                onRowClick={(p) => setOpen(p)}
                selectedKey={open?.id}
              />
            )}
            {shown.length < filtered.length ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-ui-muted">
                  Showing {shown.length} of {filtered.length} plans
                </p>
                <SecondaryButton size="md" onClick={() => setLimit((l) => l + PAGE)}>
                  Show {Math.min(PAGE, filtered.length - shown.length)} more
                </SecondaryButton>
              </div>
            ) : null}
          </div>
        </section>

        {/* The summary comes first on phones, and stays in view beside the ledger from 1280px. */}
        <aside
          aria-label="Pay in 4 summary"
          className="order-first grid min-w-0 content-start items-start gap-3 md:max-w-[560px] xl:sticky xl:top-6 xl:order-none xl:max-w-none xl:self-start"
        >
          {s ? (
            <BalanceSummaryCard
              label={
                <span className="flex items-center gap-2">
                  Paid to you up front
                </span>
              }
              value={<Money value={s.principal / 100} />}
              badge={
                <StatusPill tone="lime" size="sm">
                  100% at checkout
                </StatusPill>
              }
              stats={[
                { label: "Retrying", value: money(s.atRisk) },
                { label: "Repaid plans", value: s.repaid.toLocaleString("en-US") },
                { label: "Your risk", value: "$0.00" },
              ]}
            />
          ) : (
            <Skeleton shape="card" height={170} />
          )}
          <HowItWorks className="hidden xl:flex" />
        </aside>
        {/* Below 1280px it follows the ledger, so the summary alone leads. */}
        <HowItWorks className="md:max-w-[560px] xl:hidden" />
      </div>

      <PlanDrawer plan={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** The worked example and the three promises, beside the ledger. */
function HowItWorks({ className }: { className?: string }) {
  return (
    <PanelCard title="How Pay in 4 works" padding="md" className={className}>
      <div className="mt-4 rounded-[20px] bg-ui-surface-1 p-4">
        <p className="text-[14px] text-ui-muted">A $200.00 order</p>
        <p className="ui-figure mt-1 text-[28px] leading-none font-medium tracking-[-0.025em]">4 × {money(EXAMPLE.each)}</p>
        <Ticks done={0} total={4} className="mt-4" />
        <p className="ui-figure mt-3 text-[13px] text-ui-muted">
          Every {PLAN_INTERVAL_DAYS} days · 10% APR · {money(EXAMPLE.interest)} interest · {money(EXAMPLE.total)} in total
        </p>
      </div>
      <ul className="mt-4 grid gap-2.5 text-[14px] leading-snug">
        <li className="flex gap-2.5">
          <Check aria-hidden size={16} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ui-lime-text" />
          You get the whole order at checkout, with no fee.
        </li>
        <li className="flex gap-2.5">
          <Check aria-hidden size={16} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ui-lime-text" />
          The buyer pays 10% APR to Polaris, pro-rated over the four weeks.
        </li>
        <li className="flex gap-2.5">
          <Check aria-hidden size={16} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ui-lime-text" />
          Chainlink CRE collects each payment and retries a missed one; the risk is ours.
        </li>
      </ul>
    </PanelCard>
  );
}

const COLUMNS: TableColumn<Plan>[] = [
  {
    key: "plan",
    header: "Buyer",
    render: (p) => (
      <TableName
        className="max-w-[min(44vw,236px)]"
        icon={<BuyerCoin address={p.buyer} />}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="ui-figure truncate">{shortAddress(p.buyer, 6, 4)}</span>
          </span>
        }
        sub={
          <>
            {/* On phones the Paid, Next payment and State columns fold in here: the page's key facts. */}
            <span className="inline-flex max-w-full items-center gap-2 align-middle sm:hidden">
              <Ticks done={p.installmentsPaid} late={p.state === "dunning" ? 1 : 0} total={p.installmentCount} size="sm" className="w-16 shrink-0" />
              <span className={cn("truncate", p.state === "dunning" && "text-ui-pill-amber-text")}>{phoneLine(p)}</span>
            </span>
            <span className="hidden sm:inline">{p.description}</span>
          </>
        }
      />
    ),
  },
  {
    key: "progress",
    header: "Paid",
    hideBelow: "sm",
    render: (p) => (
      <div className="flex items-center gap-3">
        <Ticks done={p.installmentsPaid} late={p.state === "dunning" ? 1 : 0} total={p.installmentCount} className="w-24" />
        <span className="ui-figure text-[13px] text-ui-muted">
          {p.installmentsPaid}/{p.installmentCount}
        </span>
      </div>
    ),
  },
  {
    key: "next",
    header: "Next payment",
    hideBelow: "lg",
    render: (p) => (
      <span className={cn("whitespace-nowrap", p.state === "dunning" ? "text-ui-pill-amber-text" : "text-ui-muted")}>
        {p.nextDueAt ? formatDue(p.nextDueAt) : "—"}
        {p.state === "dunning" ? ` · retry ${p.attempts}` : ""}
      </span>
    ),
  },
  { key: "state", header: "State", hideBelow: "sm", render: (p) => <PlanStateBadge state={p.state} size="md" /> },
  {
    key: "outstanding",
    header: "Outstanding",
    align: "right",
    render: (p) => (
      <span className="flex flex-col items-end">
        <span className="ui-figure font-medium">{money(p.outstandingCents)}</span>
        <span className="ui-figure text-[13px] whitespace-nowrap text-ui-muted">of {money(p.totalCents)}</span>
      </span>
    ),
  },
];

/** "Retrying · 1 day overdue", "Next in 5 days", "Repaid": a plan's state in a few words. */
function phoneLine(p: Plan): string {
  if (p.state === "dunning") return `Retrying${p.nextDueAt ? ` · ${formatDue(p.nextDueAt).toLowerCase()}` : ""}`;
  if (p.state === "collecting") return p.nextDueAt ? `Next ${formatDue(p.nextDueAt).toLowerCase()}` : "Collecting";
  return p.state === "repaid" ? "Repaid" : "Written off";
}

function useSummary(plans?: Plan[]) {
  return useMemo(() => {
    if (!plans) return null;
    let outstanding = 0;
    let atRisk = 0;
    let open = 0;
    let principal = 0;
    let repaid = 0;
    for (const p of plans) {
      principal += p.principalCents;
      if (p.state === "collecting" || p.state === "dunning") {
        outstanding += p.outstandingCents;
        open += 1;
      }
      if (p.state === "dunning") atRisk += p.outstandingCents;
      if (p.state === "repaid") repaid += 1;
    }
    return { outstanding, atRisk, open, principal, repaid };
  }, [plans]);
}

type Instalment = { index: number; dueAt: number; cents: number; status: "paid" | "due" | "retrying" | "upcoming" | "written_off" };

function schedule(p: Plan): Instalment[] {
  const opened = new Date(p.openedAt).getTime();
  const each = Math.floor(p.totalCents / p.installmentCount);
  const last = p.totalCents - each * (p.installmentCount - 1);
  return Array.from({ length: p.installmentCount }, (_, i) => {
    const index = i + 1;
    // Payment k falls due k weeks after checkout (interest runs 28 days).
    const dueAt = opened + index * PLAN_INTERVAL_DAYS * DAY;
    let status: Instalment["status"] = "upcoming";
    if (index <= p.installmentsPaid) status = "paid";
    else if (p.state === "written_off") status = "written_off";
    else if (p.state === "dunning" && index === p.installmentsPaid + 1) status = "retrying";
    else if (index === p.installmentsPaid + 1) status = "due";
    return { index, dueAt, cents: index === p.installmentCount ? last : each, status };
  });
}

const STEP = {
  paid: { icon: <Check size={15} strokeWidth={2.5} />, well: "bg-ui-lime-button text-[#121418]", label: "Paid" },
  due: { icon: <Clock size={15} strokeWidth={2} />, well: "bg-ui-pill-teal text-ui-pill-teal-text", label: "Next" },
  retrying: { icon: <RotateCcw size={15} strokeWidth={2} />, well: "bg-ui-pill-amber text-ui-pill-amber-text", label: "Retrying" },
  upcoming: { icon: <Clock size={15} strokeWidth={2} />, well: "bg-ui-surface-2 text-ui-muted", label: "Upcoming" },
  written_off: { icon: <X size={15} strokeWidth={2} />, well: "bg-ui-pill-red text-ui-pill-red-text", label: "Written off" },
} as const;

function PlanDrawer({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const [last, setLast] = useState<Plan | null>(plan);
  if (plan && plan !== last) setLast(plan);
  const p = plan ?? last;
  return (
    <Drawer open={plan !== null} onOpenChange={(o) => !o && onClose()} title="Pay in 4 plan" description={p ? `${p.orderId} · ${p.id}` : undefined}>
      {p ? (
        <Drawer.Body>
          <div className="flex items-center gap-3 pb-5">
            <TableName icon={<ModeCoin mode="later" text={p.description} size={40} />} title={p.description} sub={`Opened ${formatDate(p.openedAt, true)}`} />
          </div>
          <p className="text-[14px] text-ui-muted">Still owed</p>
          <Money value={p.outstandingCents / 100} className="mt-1 text-[44px] leading-none font-medium tracking-[-0.035em]" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <PlanStateBadge state={p.state} size="md" />
            <Ticks done={p.installmentsPaid} late={p.state === "dunning" ? 1 : 0} total={p.installmentCount} className="w-32" />
          </div>
          <KeyValueGrid
            className="mt-6"
            variant="raised"
            items={[
              { label: "Paid to you up front", value: money(p.principalCents) },
              { label: "The buyer repays", value: money(p.totalCents) },
              { label: "Interest (buyer's)", value: money(p.totalCents - p.principalCents) },
              { label: "Your risk", value: "$0.00" },
            ]}
          />
          <h3 className="mt-6 text-[16px] font-medium">Schedule</h3>
          <ol className="mt-3 grid gap-2">
            {schedule(p).map((s) => {
              const step = STEP[s.status];
              return (
                <li key={s.index} className="flex items-center gap-3 rounded-[18px] bg-ui-surface-2 px-4 py-3">
                  <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-full", step.well)}>
                    {step.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium">Payment {s.index} of {p.installmentCount}</span>
                    <span className="block text-[13px] text-ui-muted">
                      {step.label} · {formatDate(new Date(s.dueAt).toISOString(), true)}
                    </span>
                  </span>
                  <span className="ui-figure text-[15px] font-medium">{money(s.cents)}</span>
                </li>
              );
            })}
          </ol>
          {p.state === "dunning" ? (
            <Notice tone="warn" size="sm" className="mt-4" title={`Collection retrying (attempt ${p.attempts})`}>
              The buyer&rsquo;s account didn&rsquo;t cover the payment. Polaris retries after 6 hours, a day and three days, and
              reminds the buyer each time. Your payout isn&rsquo;t affected.
            </Notice>
          ) : null}
          <DetailsList
            className="mt-4"
            size="sm"
            variant="raised"
            items={[
              { label: "Buyer", value: <Address value={p.buyer} label="buyer's address" /> },
              { label: "Order", value: p.orderId },
              { label: "Collected by", value: "Chainlink CRE, every minute" },
            ]}
          />
        </Drawer.Body>
      ) : null}
      {p ? (
        <DrawerActions>
          <ExplorerAction href={explorerAddress(p.buyer)} reason="No account">
            Buyer on explorer
          </ExplorerAction>
          <CopyAction value={p.buyer} what="buyer's address">
            Copy buyer
          </CopyAction>
        </DrawerActions>
      ) : null}
    </Drawer>
  );
}
