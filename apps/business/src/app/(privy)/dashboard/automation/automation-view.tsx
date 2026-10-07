"use client";

import { CheckList, EmptyState, RunList, Skeleton, StatusPill, TxLink, cn, type RunItem, type StatusPillTone } from "@polaris/ui";
import { Bot, Clock, Globe, Radio, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { LoadError, Panel, StaleNotice, useNow } from "@/components/dashboard/common";
import { PageCoin, PageHead } from "@/components/dashboard/page-head";
import { describeRun, type KeeperOverview, type KeeperRun, type KeeperJob, type WorkflowKey, type WorkflowTrigger } from "@/lib/data/keeper";
import { formatAgo } from "@/lib/data/format";
import { GUARD_REASON_TEXT, type CreditGuard } from "@/lib/data/guard";
import { useQuery, type QueryState } from "@/lib/session";

/**
 * The Automation page: the Polaris keeper's two jobs on Arc (collections and
 * credit reviews), each with its triggers and its latest reports and the
 * transaction that carried each; the keeper itself (its address and the USDC
 * it holds for gas); and the credit guard, which reads the pool live. All read
 * from the chain; on a server with nothing deployed, it says so.
 */
export function AutomationView() {
  const query = useQuery((d) => d.getAutomation(), { refreshMs: 15_000 });
  const data = query.data;

  return (
    <>
      <PageHead
        title="Automation"
        coins={[
          <PageCoin key="w" tone="blue">
            <Bot />
          </PageCoin>,
          <PageCoin key="s" tone="lime">
            <ShieldCheck />
          </PageCoin>,
        ]}
        actions={data ? <KeeperPill data={data} /> : undefined}
        description="The Polaris keeper collects what buyers owe and reviews new buyers from their history; the credit guard protects the pool that pays you. On Arc each report is one transaction, final in under a second, its gas paid in USDC. Every figure here is read from the chain."
      />
      <StaleNotice queries={[query] as QueryState<unknown>[]} />

      {!data ? (
        query.error ? (
          <LoadError query={query as QueryState<unknown>} title="We couldn't load the keeper" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_404px]">
            <Skeleton shape="card" height={420} />
            <Skeleton shape="card" height={420} />
          </div>
        )
      ) : !data.deployed ? (
        <EmptyState
          icon={<Bot />}
          title="Nothing is deployed on this server yet"
          description="This server isn't connected to Polaris's contracts on Arc. The credit guard and each keeper job's reports appear here once it is and the keeper writes its first report."
        />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_356px] xl:grid-cols-[minmax(0,1fr)_404px]">
            <GuardPanel guard={data.guard} />
            <KeeperPanel data={data} />
          </div>

          <h2 className="mt-14 text-[22px] leading-tight font-medium tracking-[-0.02em] sm:mt-16">Keeper jobs</h2>
          <p className="mt-1.5 max-w-[720px] text-[15px] leading-relaxed text-ui-muted">
            What triggers each one, and what its latest reports did on {data.network?.name ?? "Arc"}. Each report is one transaction from the keeper to a
            Polaris receiver, which accepts reports from that key alone.
          </p>
          <div className="mt-5 grid gap-4">
            {data.workflows.map((w) => (
              <WorkflowPanel key={w.key} workflow={w} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ── The keeper ─────────────────────────────────────────────────────────── */

const ALIVE_MS = 5 * 60_000;

function KeeperPill({ data }: { data: KeeperOverview }) {
  const now = useNow(15_000);
  const beat = data.keeper.lastHeartbeatAt ? now - Date.parse(data.keeper.lastHeartbeatAt) : null;
  const alive = beat !== null && beat < ALIVE_MS;
  return (
    <StatusPill tone={alive ? "lime" : "neutral"} size="sm" className="hidden sm:inline-flex">
      {alive ? "Keeper running" : "Keeper not heard from"}
    </StatusPill>
  );
}

function KeeperPanel({ data }: { data: KeeperOverview }) {
  const now = useNow(15_000);
  const k = data.keeper;
  const low = k.gasUsdc !== null && Number(k.gasUsdc) < 1;
  return (
    <Panel title="The keeper" subtitle="One key, the only one the receivers accept">
      <dl className="mt-5 grid gap-2.5 text-[14px]">
        <Row label="Network" value={data.network ? `${data.network.name} (${data.network.chainId})` : "Not configured"} />
        <Row label="Address" value={k.address ? <TxLink hash={k.address} href={k.addressUrl} kind="address" /> : "Not in the deployment record"} />
        <Row label="Gas balance" value={k.gasUsdc === null ? "—" : `${Number(k.gasUsdc).toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC`} />
        <Row label="Last heard from" value={k.lastHeartbeatAt ? formatAgo(k.lastHeartbeatAt, now) : "Never"} />
        <Row label="Credit reviews" value={k.reviewsOpen ? "Open" : "Closed on this server"} />
      </dl>
      <p className={cn("mt-4 text-[13px] leading-relaxed", low ? "text-ui-warn" : "text-ui-muted")}>
        {low
          ? "The keeper is running low on USDC for gas. Top it up: on Arc, gas is paid in USDC, so the keeper needs no other token."
          : "Arc's gas is USDC, so the keeper holds dollars and nothing else. Collecting is permissionless on the loan engine: if the keeper stops, anyone can collect what is due."}
      </p>
    </Panel>
  );
}

/* ── The risk guard ─────────────────────────────────────────────────────── */

const STATE: Record<CreditGuard["state"], { title: string; tone: "lime" | "amber" | "neutral"; body: string }> = {
  open: { title: "Pay in 4 is open", tone: "lime", body: "The credit pool passes both checks, read live on every Pay in 4. New plans open as usual." },
  paused: { title: "Pay in 4 is paused", tone: "amber", body: "New Pay in 4 plans are refused on chain. Pay now and subscriptions work as usual, and plans already open keep collecting." },
  unconfigured: { title: "No risk guard", tone: "neutral", body: "No credit guard is set on PolarisCheckout on this network, so nothing pauses Pay in 4." },
  unavailable: { title: "The guard couldn't be read", tone: "neutral", body: "The chain didn't answer just now. PolarisCheckout treats an unreadable guard as open, and so does this page." },
};

const DOT: Record<"lime" | "amber" | "neutral", string> = { lime: "bg-ui-lime", amber: "bg-ui-warn", neutral: "bg-ui-muted" };

function GuardPanel({ guard }: { guard: CreditGuard }) {
  const state =
    guard.mismatch && !guard.paused
      ? { title: "Pay in 4 is open", tone: "neutral" as const, body: "PolarisCheckout asks another guard than the one this dashboard reads, and it isn't pausing Pay in 4 now." }
      : STATE[guard.state];
  const lifted = guard.reasons.includes("owner_pause")
    ? "Polaris lifts it by hand."
    : guard.reasons.includes("bad_debt")
      ? "Bad debt never falls: Polaris acknowledges it by hand, and only new losses count after that."
      : "It opens again as soon as the pool passes.";
  return (
    <Panel title="Risk guard" subtitle="CreditGuard: whether new Pay in 4 plans may open">
      <div className="mt-5 flex items-start gap-3">
        <span aria-hidden className={cn("mt-2 size-2.5 shrink-0 rounded-full", DOT[state.tone], guard.state === "paused" && "animate-pulse")} />
        <div className="min-w-0">
          <p className="text-[24px] leading-tight font-medium tracking-[-0.02em]">{state.title}</p>
          <p className="mt-1.5 max-w-[620px] text-[14px] leading-relaxed text-ui-muted">
            {state.body}
            {guard.paused ? ` ${lifted}` : ""}
          </p>
          {guard.paused && guard.reasons.length ? (
            <ul className="mt-3 grid gap-1.5">
              {guard.reasons.map((r) => (
                <li key={r} className="flex items-center gap-2 text-[14px]">
                  <StatusPill tone="amber" size="sm">
                    {r === "owner_pause" ? "Override" : "Check failed"}
                  </StatusPill>
                  {GUARD_REASON_TEXT[r]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {guard.checks.length ? (
        <>
          <p className="mt-6 mb-3 text-[13px] text-ui-muted">
            Against today&apos;s thresholds, from the pool itself, read on every Pay in 4. USDC is Arc&apos;s unit of account, so there is no peg to watch.
          </p>
          <CheckList aria-label="The guard's checks" items={guard.checks.map((c) => ({ key: c.key, label: c.label, value: c.value, limit: c.limit, ok: c.ok }))} />
        </>
      ) : null}

      {guard.override !== "none" ? (
        <p className="mt-4 text-[13px] leading-snug text-ui-warn">
          {guard.override === "pause"
            ? "Polaris has forced a pause: the checks are ignored until it is lifted."
            : `Polaris has forced credit open: the checks are ignored${guard.overrideUntil ? ` until ${new Date(guard.overrideUntil).toUTCString().slice(5, 22)} UTC, when it ends by itself` : " for now"}.`}
        </p>
      ) : null}

      {guard.mismatch ? (
        <p className="mt-4 text-[13px] leading-snug text-ui-warn">
          PolarisCheckout asks another guard ({guard.mismatch.checkoutGuardian}) than the one this dashboard reads ({guard.mismatch.configuredGuardian}). Pay in 4
          follows the checkout&apos;s own answer; update the deployment record the API reads to see why.
        </p>
      ) : null}
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-ui-hairline pb-2.5 last:border-0 last:pb-0">
      <dt className="text-ui-muted">{label}</dt>
      <dd className="ui-figure min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}

/* ── Each workflow ──────────────────────────────────────────────────────── */

const TRIGGER_ICON: Record<WorkflowTrigger["kind"], ReactNode> = {
  timer: <Clock />,
  "evm-log": <Radio />,
  http: <Globe />,
};

function tagFor(key: WorkflowKey, run: KeeperRun): { tag: string; tone: StatusPillTone } {
  if (key === "collections" && run.collections) {
    const c = run.collections;
    if (c.afterReauthorization) return { tag: "Instant retry", tone: "purple" };
    if (c.collected || c.charged) return { tag: "Collected", tone: "lime" };
    if (c.liquidated) return { tag: "Closed", tone: "amber" };
    if (c.skipped) return { tag: "Dunned", tone: "amber" };
    return { tag: "Checked", tone: "neutral" };
  }
  if (key === "underwrite" && run.underwrite) return run.underwrite.applied ? { tag: "Line opened", tone: "purple" } : { tag: "Refused", tone: "amber" };
  return { tag: "Report", tone: "neutral" };
}

function WorkflowPanel({ workflow: w }: { workflow: KeeperJob }) {
  const now = useNow(1_000);
  const items: RunItem[] = w.runs.map((run) => {
    const line = describeRun(w.key, run);
    const { tag, tone } = tagFor(w.key, run);
    return {
      id: run.txHash,
      tag,
      tone,
      title: line.title,
      detail: line.detail,
      meta: ago(run.at, now),
      trailing: <TxLink hash={run.txHash} href={run.explorerUrl} />,
    };
  });
  return (
    <Panel
      title={w.name}
      subtitle={w.role}
      action={w.receiver ? <TxLink hash={w.receiver} href={w.receiverUrl} kind="receiver contract" /> : undefined}
    >
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-8">
        <div className="grid content-start gap-4">
          <ul className="grid gap-3" aria-label="Triggers">
            {w.triggers.map((t, i) => (
              <li key={`${t.kind}-${i}`} className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ui-surface-1 text-ui-lime-text [&_svg]:size-4 [&_svg]:stroke-[1.75]">{TRIGGER_ICON[t.kind]}</span>
                <span className="min-w-0 text-[14px] leading-snug">
                  <span className="font-medium">{t.label}</span>
                  <span className="block text-ui-muted">{t.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2.5">
            <Figure label="Last report" value={w.lastRunAt ? ago(w.lastRunAt, now) : "None yet"} />
            <Figure label="Last 24 hours" value={`${w.runs24h.toLocaleString("en-US")} ${w.runs24h === 1 ? "report" : "reports"}`} />
          </div>
        </div>
        <RunList
          aria-label={`${w.name}: latest reports`}
          items={items}
          empty={
            <div className="grid place-items-center rounded-[18px] border border-dashed border-ui-hairline-strong px-6 py-10 text-center">
              <p className="text-[15px] font-medium">No reports yet</p>
              <p className="mt-1 max-w-[420px] text-[13.5px] leading-relaxed text-ui-muted">
                They appear here as soon as the keeper writes one to the receiver.
              </p>
            </div>
          }
        />
      </div>
    </Panel>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] bg-ui-surface-1 px-4 py-3">
      <p className="text-[13px] text-ui-muted">{label}</p>
      <p className="ui-figure mt-1 text-[17px] leading-tight font-medium tracking-[-0.01em]">{value}</p>
    </div>
  );
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s ago` : formatAgo(iso, now);
}
