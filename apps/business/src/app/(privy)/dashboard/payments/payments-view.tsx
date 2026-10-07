"use client";

import {
  BalanceSummaryCard,
  DataTable,
  DetailsList,
  Drawer,
  EmptyState,
  IconSquareButton,
  Input,
  KeyValueGrid,
  Money,
  PanelCard,
  PrimaryButton,
  ProgressLegend,
  SecondaryButton,
  Select,
  Skeleton,
  StatusPill,
  TimeframeChips,
  cn,
  type TableColumn,
} from "@polaris/ui";
import { ArrowLeftRight, CalendarClock, Download, Link2, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Address, CopyAction, DrawerActions, ExplorerAction, ModeBadge, PaymentStatusBadge, TxLink, downloadCsv } from "@/components/dashboard/bits";
import { DataModeNotice, LoadError, StaleNotice, useNow } from "@/components/dashboard/common";
import { FigureRow, PageHead } from "@/components/dashboard/page-head";
import { MODE_COLOR, PaymentName, paymentPill } from "@/components/dashboard/payment-bits";
import { explorerTx } from "@/lib/chain";
import { periodSummary } from "@/lib/data/analytics";
import { formatDateTime, MODE_LABEL, money } from "@/lib/data/format";
import type { PayMode, Payment } from "@/lib/data/types";
import { LIVE_REFRESH_MS, useQuery, type QueryState } from "@/lib/session";

type StatusFilter = "all" | "succeeded" | "failed";
type ModeFilter = "all" | PayMode;

const PAGE = 40;

export function PaymentsView() {
  const payments = useQuery((d) => d.listPayments(), { refreshMs: LIVE_REFRESH_MS });
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get("open");

  const [status, setStatus] = useState<StatusFilter>("all");
  const [mode, setMode] = useState<ModeFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const list = payments.data;
  const filtered = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase();
    return list.filter(
      (p) =>
        (status === "all" || p.status === status) &&
        (mode === "all" || p.mode === mode) &&
        (!q || `${p.description} ${p.orderId} ${p.id} ${p.buyer}`.toLowerCase().includes(q)),
    );
  }, [list, status, mode, query]);

  const counts = useMemo(
    () => ({
      all: list?.length ?? 0,
      succeeded: list?.filter((p) => p.status === "succeeded").length ?? 0,
      failed: list?.filter((p) => p.status === "failed").length ?? 0,
    }),
    [list],
  );

  const open = openId ? (list?.find((p) => p.id === openId) ?? null) : null;
  const setOpen = (p: Payment | null) => {
    const next = new URLSearchParams(params.toString());
    if (p) next.set("open", p.id);
    else next.delete("open");
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  const exportCsv = () =>
    downloadCsv(
      `polaris-payments-${new Date().toISOString().slice(0, 10)}.csv`,
      ["id", "order", "created_at", "description", "mode", "status", "amount_usd", "fee_usd", "net_usd", "buyer", "tx_hash"],
      filtered.map((p) => [
        p.id,
        p.orderId,
        p.createdAt,
        p.description,
        MODE_LABEL[p.mode],
        p.status === "succeeded" ? "paid" : "failed",
        (p.amountCents / 100).toFixed(2),
        (p.feeCents / 100).toFixed(2),
        (p.netCents / 100).toFixed(2),
        p.buyer,
        p.txHash,
      ]),
    );

  const shown = filtered.slice(0, limit);
  const summary = useSummary(list);

  return (
    <>
      <PageHead
        title="Payments"
        actions={<IconSquareButton label="Export these payments as CSV" icon={<Download />} onClick={exportCsv} disabled={!filtered.length} />}
      />
      <StaleNotice queries={[payments as QueryState<unknown>]} />
      <DataModeNotice empty={list !== undefined && list.length === 0} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-11 gap-y-10 xl:grid-cols-[minmax(0,1fr)_404px]">
        <section aria-label="All payments" className="min-w-0">
          <FigureRow
            caption="Gross, last 30 days"
            value={summary ? <Money value={summary.gross / 100} /> : undefined}
            delta={summary?.delta}
            deltaSuffix="vs the 30 days before"
            deltaLabel={summary && summary.delta === null ? "New" : undefined}
          />

          {/* The table covers every payment, not the figure's 30 days, so its
              filters sit with it and say so. */}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <h2 className="text-[15px] font-medium">
              Every payment <span className="font-normal text-ui-muted">· all time</span>
            </h2>
            <TimeframeChips<StatusFilter>
              aria-label="Filter by status, all time"
              options={[
                { value: "all", label: `All ${counts.all}` },
                { value: "succeeded", label: `Paid ${counts.succeeded}` },
                { value: "failed", label: `Failed ${counts.failed}` },
              ]}
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setLimit(PAGE);
              }}
            />
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Input
              hideLabel
              label="Search payments"
              placeholder="Search description, order or buyer"
              icon={<Search />}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
              }}
              wrapperClassName="w-full sm:flex-1"
              className="h-12"
            />
            <Select<ModeFilter>
              aria-label="Payment mode"
              variant="outline"
              value={mode}
              onValueChange={(v) => {
                setMode(v);
                setLimit(PAGE);
              }}
              options={[
                { value: "all", label: "All modes" },
                { value: "now", label: "Pay now" },
                { value: "later", label: "Pay in 4" },
                { value: "subscribe", label: "Subscribe" },
              ]}
            />
          </div>

          <div className="mt-4">
            {payments.error && !list ? (
              <LoadError query={payments as QueryState<unknown>} title="We couldn't load your payments" />
            ) : list && filtered.length === 0 ? (
              <EmptyState
                icon={list.length ? <Search /> : <ArrowLeftRight />}
                title={list.length ? "No payments match" : "No payments yet"}
                description={list.length ? "Try another word, or clear the filters." : "Share a payment link and each payment appears here the moment it settles."}
                action={
                  list.length ? null : (
                    <PrimaryButton asChild size="sm" icon={<Link2 />}>
                      <Link href="/dashboard/links?new=1">New payment link</Link>
                    </PrimaryButton>
                  )
                }
              />
            ) : (
              <DataTable
                caption="Payments"
                loading={!list}
                loadingRows={8}
                columns={COLUMNS}
                rows={shown}
                rowKey={(p) => p.id}
                onRowClick={(p) => setOpen(p)}
                selectedKey={open?.id}
              />
            )}
            {filtered.length > shown.length ? (
              <div className="mt-4 flex justify-center">
                <SecondaryButton size="md" onClick={() => setLimit((l) => l + PAGE)}>
                  Show {Math.min(PAGE, filtered.length - shown.length)} more
                </SecondaryButton>
              </div>
            ) : null}
          </div>
        </section>

        {/* The Net card comes first on phones (By mode follows the table there),
            and the summary stays in view beside the table from 1280px. */}
        <aside
          aria-label="Payments summary"
          className="order-first grid min-w-0 content-start items-start gap-3 md:max-w-[560px] xl:sticky xl:top-6 xl:order-none xl:max-w-none xl:self-start"
        >
          {summary ? (
            <BalanceSummaryCard
              label={
                <span className="flex items-center gap-2">
                  Net to you, 30 days
                </span>
              }
              value={<Money value={summary.net / 100} />}
              stats={[
                { label: "Fees", value: money(summary.fees) },
                { label: "Paid", value: summary.count.toLocaleString("en-US") },
                { label: "Failed", value: summary.failed.toLocaleString("en-US") },
              ]}
            />
          ) : (
            <Skeleton shape="card" height={170} />
          )}
          <ByMode summary={summary} className="hidden xl:flex" />
          <div className="hidden gap-3 xl:mt-1 xl:grid">
            <SummaryActions onExport={exportCsv} canExport={filtered.length > 0} />
          </div>
        </aside>
        {/* Below 1280px By mode and the actions follow the table, so the Net card alone leads. */}
        <div className="grid items-start gap-3 md:grid-cols-2 xl:hidden">
          <ByMode summary={summary} />
          <div className="grid gap-3">
            <SummaryActions onExport={exportCsv} canExport={filtered.length > 0} />
          </div>
        </div>
      </div>

      <PaymentDrawer payment={open} onClose={() => setOpen(null)} />
    </>
  );
}

function ByMode({ summary, className }: { summary: ReturnType<typeof useSummary>; className?: string }) {
  return (
    <PanelCard title="By mode" subtitle="Share of gross, last 30 days" padding="md" className={className}>
      {summary ? (
        <ProgressLegend
          className="mt-5"
          direction="column"
          items={summary.modes.map((m) => ({ label: MODE_LABEL[m.mode], value: m.share, color: MODE_COLOR[m.mode] }))}
        />
      ) : (
        <Skeleton shape="tile" height={140} className="mt-4" />
      )}
    </PanelCard>
  );
}

function SummaryActions({ onExport, canExport }: { onExport: () => void; canExport: boolean }) {
  return (
    <>
      <PrimaryButton asChild size="lg" block icon={<Link2 />}>
        <Link href="/dashboard/links?new=1">New payment link</Link>
      </PrimaryButton>
      <SecondaryButton size="lg" block iconRight={<Download />} onClick={onExport} disabled={!canExport}>
        Export CSV
      </SecondaryButton>
      <p className="px-1 text-[13px] leading-relaxed text-ui-muted">
        Pay now and subscriptions cost 0.5% per payment. Pay in 4 costs you nothing: the buyer pays 10% APR to Polaris, and you are paid in full at checkout.
      </p>
    </>
  );
}

const COLUMNS: TableColumn<Payment>[] = [
  // No Order column: the customer's sub line already names the merchant's order ("Halcyon order HC-59475"); the drawer has the ref.
  { key: "customer", header: "Customer", render: (p) => <PaymentName p={p} sub /> },
  { key: "date", header: "Date", hideBelow: "md", render: (p) => <span className="whitespace-nowrap text-ui-muted">{formatDateTime(p.createdAt)}</span> },
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
    key: "amount",
    header: "Amount",
    align: "right",
    render: (p) => (
      <span className="flex flex-col items-end whitespace-nowrap">
        <span className={cn("ui-figure", p.status === "failed" ? "text-ui-muted line-through" : "font-medium")}>{money(p.amountCents)}</span>
        <span className="ui-figure text-[13px] text-ui-muted">{p.status === "failed" ? "Failed" : p.feeCents ? `Net ${money(p.netCents)}` : "No fee"}</span>
      </span>
    ),
  },
];

/**
 * The last 30 days, the Overview's window, against the 30 before. On a live
 * clock (the window rolls over at midnight); a payment newer than the clock
 * counts as now, so a refresh shows it in the figures at once.
 */
function useSummary(payments: Payment[] | undefined) {
  const now = useNow(60_000);
  return useMemo(() => (payments ? periodSummary(payments, { days: 30, now }) : null), [payments, now]);
}

function PaymentDrawer({ payment, onClose }: { payment: Payment | null; onClose: () => void }) {
  const [last, setLast] = useState<Payment | null>(payment);
  if (payment && payment !== last) setLast(payment);
  const p = payment ?? last;
  return (
    <Drawer open={payment !== null} onOpenChange={(o) => !o && onClose()} title="Payment" description={p ? `${p.orderId} · ${p.id}` : undefined}>
      {p ? (
        <Drawer.Body>
          <div className="flex items-center gap-3 pb-5">
            <PaymentName p={p} sub />
          </div>
          <Money value={p.amountCents / 100} className="text-[44px] leading-none font-medium tracking-[-0.035em]" />
          <div className="mt-4 flex flex-wrap gap-2">
            <PaymentStatusBadge status={p.status} size="md" />
            <ModeBadge mode={p.mode} size="md" />
          </div>
          <KeyValueGrid
            className="mt-6"
            variant="raised"
            items={[
              { label: "Amount", value: money(p.amountCents) },
              { label: "Fee", value: p.mode === "later" ? "$0.00 (Pay in 4)" : money(p.feeCents) },
              { label: "Net to you", value: money(p.netCents) },
              { label: "Settled", value: p.status === "succeeded" ? "Under a second" : "Didn't settle" },
            ]}
          />
          <DetailsList
            className="mt-4"
            size="sm"
            variant="raised"
            items={[
              { label: "Date", value: formatDateTime(p.createdAt) },
              { label: "Order", value: p.orderId },
              { label: "Buyer", value: <Address value={p.buyer} label="buyer's address" /> },
              { label: "Link", value: p.linkId ?? "Checkout" },
              { label: "Transaction", value: <TxLink hash={p.txHash} /> },
            ]}
          />
        </Drawer.Body>
      ) : null}
      {p ? (
        <DrawerActions>
          <ExplorerAction href={p.txHash ? explorerTx(p.txHash) : null} reason="Not on chain yet">
            View transaction
          </ExplorerAction>
          {p.mode === "later" && p.status === "succeeded" ? (
            <SecondaryButton asChild size="md" icon={<CalendarClock />} className="bg-ui-surface-2 hover:bg-ui-surface-3">
              <Link href={`/dashboard/plans?order=${encodeURIComponent(p.orderId)}`}>Pay in 4 plan</Link>
            </SecondaryButton>
          ) : (
            <CopyAction value={p.orderId} what="order ID">
              Copy order ID
            </CopyAction>
          )}
        </DrawerActions>
      ) : null}
    </Drawer>
  );
}
