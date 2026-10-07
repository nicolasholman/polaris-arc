"use client";

import {
  Coin,
  DataTable,
  DetailsList,
  Drawer,
  EmptyState,
  Input,
  KeyValueGrid,
  Money,
  Notice,
  PanelCard,
  PolarisCoin,
  SecondaryButton,
  Skeleton,
  TableName,
  Toggle,
  WalletPill,
  toast,
  type TableColumn,
} from "@polaris/ui";
import { ArrowUpFromLine, CalendarClock, Landmark, Zap } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Address, CopyAction, DrawerActions, ExplorerAction, PayoutStatusBadge, TxLink } from "@/components/dashboard/bits";
import { BalanceUnknown, DataModeNotice, LoadError, StaleNotice } from "@/components/dashboard/common";
import { checkAddress, MoneyWidget } from "@/components/dashboard/money-widget";
import { FigureRow, PageCoin, PageHead } from "@/components/dashboard/page-head";
import { explorerTx } from "@/lib/chain";
import { errorMessage } from "@/lib/data";
import { formatDateTime, money, shortAddress } from "@/lib/data/format";
import type { AutoPayouts, Payout } from "@/lib/data/types";
import { useMerchant } from "@/lib/merchant-context";
import { useAutoPayouts } from "@/lib/payouts";
import { LIVE_REFRESH_MS, useDashboardData, useQuery, useReadiness, type QueryState } from "@/lib/session";

/** Payouts shown at a time in the history. */
const HISTORY_PAGE = 10;

function PayoutCoin({ p, size = 28 }: { p: Payout; size?: number }) {
  return (
    <Coin tone={p.kind === "automatic" ? "teal" : "lime"} size={size}>
      <span className="inline-grid place-items-center [&_svg]:size-full" style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }}>
        {p.kind === "automatic" ? <CalendarClock strokeWidth={2.25} /> : <ArrowUpFromLine strokeWidth={2.25} />}
      </span>
    </Coin>
  );
}

const COLUMNS: TableColumn<Payout>[] = [
  {
    key: "payout",
    header: "Payout",
    render: (p) => <TableName icon={<PayoutCoin p={p} />} title={p.kind === "automatic" ? "Automatic payout" : "Withdrawal"} sub={formatDateTime(p.createdAt)} />,
  },
  { key: "to", header: "To", hideBelow: "md", render: (p) => <span className="ui-figure whitespace-nowrap text-ui-muted">{shortAddress(p.destination, 6, 4)}</span> },
  { key: "status", header: "Status", hideBelow: "sm", render: (p) => <PayoutStatusBadge status={p.status} size="md" /> },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    render: (p) => (
      <span className="flex flex-col items-end">
        <span className="ui-figure font-medium">{money(p.amountCents)}</span>
        <span className="text-[13px] text-ui-muted">Fee $0.00</span>
      </span>
    ),
  },
];

export function PayoutsView() {
  const { merchant } = useMerchant();
  const payouts = useQuery((d) => d.getPayouts(), { refreshMs: LIVE_REFRESH_MS });
  const payments = useQuery((d) => d.listPayments(), { refreshMs: LIVE_REFRESH_MS });
  const [open, setOpen] = useState<Payout | null>(null);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const state = payouts.data;
  const wallet = state?.walletAddress ?? merchant.walletAddress;
  const history = useMemo(() => state?.history ?? [], [state]);
  const paidOut = useMemo(() => history.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountCents, 0), [history]);

  return (
    <>
      <PageHead
        title="Payouts"
        coins={[
          <PolarisCoin key="p" size={50} />,
          <PageCoin key="b" tone="teal">
            <Landmark />
          </PageCoin>,
        ]}
      />
      <StaleNotice queries={[payouts as QueryState<unknown>]} />
      <DataModeNotice empty={state !== undefined && state.balanceCents === 0 && state.history.length === 0} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-11 gap-y-10 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_452px]">
        <div className="grid min-w-0 content-start gap-10 lg:col-start-1 lg:row-start-1">
          <section aria-label="Your balance" className="min-w-0">
            <FigureRow
              caption="Available to withdraw"
              value={(payouts.error && !state) || state?.balanceCents === null ? "—" : state ? <Money value={state.balanceCents / 100} /> : undefined}
              deltaLabel={state && state.balanceCents !== null ? "AUSD on Monad" : undefined}
              right={wallet ? <WalletPill address={wallet} label="payout account address" maxWidth={300} /> : null}
            />
            {payouts.error && !state ? <LoadError query={payouts as QueryState<unknown>} title="We couldn't load your balance" /> : null}
            {state?.balanceCents === null ? <BalanceUnknown className="mt-4" onRetry={payouts.reload} retrying={payouts.refreshing} /> : null}
            <p className="mt-3 max-w-[600px] text-[15px] leading-relaxed text-ui-muted">
              Your balance is dollars (AUSD) in a payout account only you control. Move it in one tap, or every day on its own. Polaris&rsquo;s relayer
              pays the network fee.
            </p>
            <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Paid out" value={state ? money(paidOut) : undefined} className="col-span-2 sm:col-span-1" />
              <Stat label="Payouts" value={state ? String(history.length) : undefined} />
              <Stat label="Network fee" value="$0.00" />
            </dl>
          </section>

          <AutoPayoutsPanel
            auto={state?.auto}
            wallet={wallet}
            suggested={state?.history.find((p) => p.status !== "failed")?.destination ?? null}
            onChange={(auto) => payouts.mutate((s) => (s ? { ...s, auto } : s))}
            onPaidOut={payouts.reload}
          />

          <section aria-label="Payout history" className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-[22px] leading-tight font-medium tracking-[-0.02em]">
                History
              </h2>
              <span className="text-[14px] text-ui-muted">Every withdrawal and automatic payout</span>
            </div>
            {state && history.length === 0 ? (
              <EmptyState size="sm" icon={<Landmark />} title="No payouts yet" description="Withdrawals and daily payouts show here with their status." />
            ) : (
              <DataTable
                caption="Payout history"
                loading={!state}
                loadingRows={4}
                columns={COLUMNS}
                rows={history.slice(0, historyLimit)}
                rowKey={(p) => p.id}
                onRowClick={(p) => setOpen(p)}
                selectedKey={open?.id}
              />
            )}
            {history.length > historyLimit ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-ui-muted">
                  Showing {historyLimit} of {history.length}
                </p>
                <SecondaryButton size="md" onClick={() => setHistoryLimit((l) => l + HISTORY_PAGE)}>
                  Show {Math.min(HISTORY_PAGE, history.length - historyLimit)} more
                </SecondaryButton>
              </div>
            ) : null}
          </section>
        </div>

        {/* The page's main action: first on phones, on the right from 1024px. */}
        <MoneyWidget
          payouts={payouts}
          payments={payments.data}
          settingsHref="#automatic"
          className="order-first lg:order-none lg:col-start-2 lg:row-start-1 lg:self-start xl:sticky xl:top-6"
        />
      </div>

      <PayoutDrawer payout={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Stat({ label, value, className }: { label: string; value: ReactNode | undefined; className?: string }) {
  return (
    <div className={`min-w-0 rounded-[20px] bg-ui-surface-1 px-4 py-3.5 ${className ?? ""}`}>
      <dt className="truncate text-[13px] text-ui-muted">{label}</dt>
      <dd className="ui-figure mt-1 truncate text-[18px] leading-tight font-medium">{value ?? <Skeleton width={80} height={20} />}</dd>
    </div>
  );
}

/* ── Automatic payouts: the Privy session signer ────────────────────────── */

function AutoPayoutsPanel({
  auto,
  wallet,
  onChange,
  onPaidOut,
  suggested,
}: {
  auto?: AutoPayouts;
  wallet: string | null;
  /** Where the merchant last withdrew to: the address the form starts with until one is saved. */
  suggested?: string | null;
  onChange: (a: AutoPayouts) => void;
  onPaidOut: () => void;
}) {
  const data = useDashboardData();
  const { enable, disable } = useAutoPayouts();
  // null until edited: the input shows the saved payout address, the same one
  // the status row below names.
  const [draft, setDraft] = useState<string | null>(null);
  const address = draft ?? auto?.payoutAddress ?? suggested ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  const blocker = useReadiness().autoPayouts;
  const canEnable = !blocker && Boolean(wallet);
  const enabled = auto?.enabled ?? false;

  const payNow = async () => {
    setError(null);
    setRunning(true);
    try {
      const run = await data.payoutNow();
      if (run.result === "failed") setError(run.detail ?? "The payout didn't go through. Nothing was sent.");
      else toast({ title: run.result === "paid" ? "Paying out your balance" : "Nothing to pay out", description: run.detail, tone: run.result === "paid" ? "success" : "info" });
      onPaidOut();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const toggle = async (on: boolean) => {
    setError(null);
    if (!on) {
      setBusy(true);
      try {
        onChange(await disable(auto?.payoutAddress ?? null));
        toast({ title: "Automatic payouts are off", tone: "success" });
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    const checked = checkAddress(address, wallet);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    try {
      onChange(await enable(checked.address));
      toast({ title: "Automatic payouts are on", description: `Daily to ${shortAddress(checked.address)}.`, tone: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hour = String(auto?.hourUtc ?? 17).padStart(2, "0");
  return (
    <PanelCard
      id="automatic"
      title="Automatic payouts"
      subtitle="Sweep your balance every day, without signing each time"
      className="scroll-mt-6"
    >
      {!auto ? (
        <Skeleton shape="tile" height={200} className="mt-5" />
      ) : (
        // One column, in the order it's used: the switch, where it pays out
        // to, then its state, then how it's kept safe.
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4">
          <div className="grid content-start gap-4">
            <div className="rounded-[20px] bg-ui-surface-1 px-4 py-3.5">
              <Toggle
                label="Automatic daily payouts"
                description={`Every day at ${hour}:00 UTC, your whole balance goes to one address you choose.`}
                checked={enabled}
                // Turning off always works; turning on needs the signer and the sweep.
                disabled={busy || (enabled ? false : !canEnable)}
                onCheckedChange={toggle}
              />
            </div>
            {!enabled && canEnable ? (
              <Input
                label="Pay out to"
                placeholder="0x…"
                value={address}
                onChange={(e) => setDraft(e.target.value)}
                className="ui-figure text-[14px]"
                spellCheck={false}
              />
            ) : null}
            {error ? (
              <Notice tone="down" size="sm" role="alert">
                {error}
              </Notice>
            ) : null}
            {enabled && blocker ? (
              <Notice tone="warn" size="sm" title="Recorded as on, but not running">
                {blocker} Nothing is sent automatically until then.
              </Notice>
            ) : blocker ? (
              <Notice tone="info" size="sm">
                {blocker}
              </Notice>
            ) : null}
          </div>
          <div className="grid content-start gap-4">
            {/* Full width, so the short address is never cut again. */}
            <DetailsList
              size="sm"
              variant="surface"
              items={[
                { label: "Status", value: enabled ? (blocker ? "On, not running" : "On") : "Off" },
                {
                  label: "Pays out to",
                  value: auto.payoutAddress ? (
                    <span className="ui-figure whitespace-nowrap" title={auto.payoutAddress}>
                      {shortAddress(auto.payoutAddress, 6, 4)}
                    </span>
                  ) : (
                    // Withdrawals and the daily sweep keep their own addresses; this one is saved by turning it on.
                    "Not set yet (its own setting)"
                  ),
                },
                { label: "Next payout", value: enabled && !blocker && auto.nextRunAt ? formatDateTime(auto.nextRunAt) : "—" },
              ]}
            />
            {enabled && !blocker ? (
              <SecondaryButton size="md" block icon={<Zap />} loading={running} onClick={() => void payNow()}>
                Pay out now
              </SecondaryButton>
            ) : null}
            <p className="text-[13px] leading-relaxed text-ui-muted">
              A Privy session signer does the daily sweep. Its policy lets it send AUSD to your chosen address and nowhere else, and you can remove it at any
              time by turning this off.
            </p>
          </div>
        </div>
      )}
    </PanelCard>
  );
}

function PayoutDrawer({ payout, onClose }: { payout: Payout | null; onClose: () => void }) {
  const [last, setLast] = useState<Payout | null>(payout);
  if (payout && payout !== last) setLast(payout);
  const p = payout ?? last;
  const title = p?.kind === "automatic" ? "Automatic payout" : "Withdrawal";
  const items = useMemo(
    () =>
      p
        ? [
            { label: "Status", value: <PayoutStatusBadge status={p.status} /> },
            { label: "To", value: <Address value={p.destination} label="destination address" /> },
            { label: "When", value: formatDateTime(p.createdAt) },
            { label: "Confirmed by", value: p.signed ? "Your payout account's signature" : "Not signed" },
            { label: "Transaction", value: <TxLink hash={p.txHash} /> },
          ]
        : [],
    [p],
  );
  return (
    <Drawer open={payout !== null} onOpenChange={(o) => !o && onClose()} title={title} description={p?.id}>
      {p ? (
        <Drawer.Body>
          <div className="flex items-center gap-3 pb-5">
            <TableName icon={<PayoutCoin p={p} size={40} />} title={title} sub={formatDateTime(p.createdAt)} />
          </div>
          <Money value={p.amountCents / 100} className="text-[44px] leading-none font-medium tracking-[-0.035em]" />
          <KeyValueGrid
            className="mt-6"
            variant="raised"
            items={[
              { label: "Amount", value: money(p.amountCents) },
              { label: "Network fee", value: "$0.00" },
            ]}
          />
          <DetailsList className="mt-4" size="sm" variant="raised" items={items} />
          {p.status === "queued" ? (
            <p className="mt-4 rounded-[20px] bg-ui-surface-2 px-5 py-4 text-[14px] leading-relaxed text-ui-muted">
              Queued means your signed withdrawal is waiting for the relayer. It turns Paid, with its transaction, once it&rsquo;s on chain.
            </p>
          ) : null}
        </Drawer.Body>
      ) : null}
      {p ? (
        <DrawerActions>
          <ExplorerAction href={p.txHash ? explorerTx(p.txHash) : null} reason="Not on chain yet">
            View on explorer
          </ExplorerAction>
          <CopyAction value={p.destination} what="destination address">
            Copy address
          </CopyAction>
        </DrawerActions>
      ) : null}
    </Drawer>
  );
}
