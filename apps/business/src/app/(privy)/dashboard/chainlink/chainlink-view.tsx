"use client";

import {
  CheckList,
  CodeBlock,
  EmptyState,
  Meter,
  RunList,
  Skeleton,
  StatusPill,
  TxLink,
  cn,
  type RunItem,
  type StatusPillTone,
} from "@polaris/ui";
import { Clock, Globe, Radio, ShieldCheck, Workflow } from "lucide-react";
import type { ReactNode } from "react";

import { LoadError, Panel, StaleNotice, useNow } from "@/components/dashboard/common";
import { PageCoin, PageHead } from "@/components/dashboard/page-head";
import { deliveryLabel, describeRun, type ChainlinkOverview, type ChainlinkRun, type ChainlinkWorkflow, type WorkflowKey, type WorkflowTrigger } from "@/lib/data/chainlink";
import { nextCronFire } from "@/lib/data/cron";
import { formatAgo } from "@/lib/data/format";
import { checkedAgo, GUARD_REASON_TEXT, guardAgeSeconds, type CreditGuard } from "@/lib/data/guard";
import { useQuery, type QueryState } from "@/lib/session";

/**
 * The Chainlink page: Polaris's three Chainlink CRE workflows as they run on
 * Monad. The risk guard's verdict and its checks, the pool-health feed it
 * publishes, and for each workflow its triggers and its latest reports, each
 * with the transaction that carried it. All read from the chain (the API's
 * chain sync and the guardian's views); on a server with nothing deployed, it
 * says so.
 */
export function ChainlinkView() {
  const query = useQuery((d) => d.getChainlink(), { refreshMs: 15_000 });
  const data = query.data;

  return (
    <>
      <PageHead
        title="Chainlink"
        coins={[
          <PageCoin key="w" tone="blue">
            <Workflow />
          </PageCoin>,
          <PageCoin key="s" tone="lime">
            <ShieldCheck />
          </PageCoin>,
        ]}
        actions={data ? <DeliveryPill data={data} /> : undefined}
        description="Three Chainlink CRE workflows run Polaris's credit: they collect what buyers owe, underwrite new buyers from their wallet history, and guard the pool that pays you. Every figure here is read from the chain."
      />
      <StaleNotice queries={[query] as QueryState<unknown>[]} />

      {!data ? (
        query.error ? (
          <LoadError query={query as QueryState<unknown>} title="We couldn't load the Chainlink workflows" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_404px]">
            <Skeleton shape="card" height={420} />
            <Skeleton shape="card" height={420} />
          </div>
        )
      ) : !data.deployed ? (
        <EmptyState
          icon={<Workflow />}
          title="Nothing is deployed on this server yet"
          description="This server isn't connected to Polaris's contracts on Monad. The risk guard, the pool health feed and each workflow's reports appear here once it is and a workflow writes its first report."
        />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_356px] xl:grid-cols-[minmax(0,1fr)_404px]">
            <GuardPanel guard={data.guard} />
            <FeedPanel guard={data.guard} explorer={data.network?.explorerUrl ?? null} />
          </div>

          <h2 className="mt-14 text-[22px] leading-tight font-medium tracking-[-0.02em] sm:mt-16">Workflows</h2>
          <p className="mt-1.5 max-w-[720px] text-[15px] leading-relaxed text-ui-muted">
            What triggers each one, and what its latest reports did on {data.network?.name ?? "Monad"}. Each report is one transaction through
            Chainlink&apos;s forwarder to a Polaris receiver.
          </p>
          <div className="mt-5 grid gap-4">
            {data.workflows.map((w) => (
              <WorkflowPanel key={w.key} workflow={w} localRun={data.delivery.forwarderKind === "local"} />
            ))}
          </div>

          <DeliveryPanel data={data} className="mt-4" />
        </>
      )}
    </>
  );
}

/* ── How reports get here ───────────────────────────────────────────────── */

function DeliveryPill({ data }: { data: ChainlinkOverview }) {
  const kind = data.delivery.forwarderKind;
  const text = kind === "production" ? "Deployed on the DON" : kind === "simulation" ? "simulate --broadcast" : kind === "local" ? "Local run" : "Not deployed";
  return (
    <StatusPill tone={kind === "production" ? "lime" : kind === "simulation" ? "teal" : "neutral"} size="sm" title={deliveryLabel(kind)} className="hidden sm:inline-flex">
      {text}
    </StatusPill>
  );
}

function DeliveryPanel({ data, className }: { data: ChainlinkOverview; className?: string }) {
  const d = data.delivery;
  const explorer = data.network?.explorerUrl ?? null;
  return (
    <Panel title="How reports reach Monad" subtitle={deliveryLabel(d.forwarderKind)} className={className}>
      <dl className="mt-4 grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-2 xl:grid-cols-4">
        <Fact label="Network" value={data.network ? `${data.network.name} (${data.network.chainId})` : "Not configured"} />
        <Fact label="Forwarder" value={d.forwarder ? <TxLink hash={d.forwarder} href={explorer ? `${explorer}/address/${d.forwarder}` : null} kind="contract" /> : "—"} />
        <Fact
          label="Receivers"
          value={d.locked ? "Locked to the deployed workflows" : "Accept any workflow until locked"}
          title={d.locked ? "setExpectedAuthor, setExpectedWorkflowName and setExpectedWorkflowId are set on every receiver." : "lock-receivers:monad pins the author, name and workflow id once the workflows are deployed."}
        />
        <Fact label="Workflow owner" value={d.workflowOwner ? <TxLink hash={d.workflowOwner} href={explorer ? `${explorer}/address/${d.workflowOwner}` : null} kind="address" /> : "Not set yet"} />
      </dl>
    </Panel>
  );
}

function Fact({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[13px] text-ui-muted">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}

/* ── The risk guard ─────────────────────────────────────────────────────── */

const STATE: Record<CreditGuard["state"], { title: string; tone: "lime" | "amber" | "neutral"; body: string }> = {
  open: { title: "Pay in 4 is open", tone: "lime", body: "The latest check found the peg healthy, and the pool passes. New plans open as usual." },
  paused: { title: "Pay in 4 is paused", tone: "amber", body: "New Pay in 4 plans are refused on chain. Pay now and subscriptions work as usual, and plans already open keep collecting." },
  stale: { title: "Pay in 4 is open: the price check is late", tone: "amber", body: "The last price check is older than the guard allows, so the price no longer blocks anything (it fails open) until the next check lands. The pool's own checks still apply." },
  never: { title: "Pay in 4 is open: no price check yet", tone: "neutral", body: "The guardian hasn't written a report yet. Until it does, only the pool's own checks can pause Pay in 4." },
  unconfigured: { title: "No risk guard", tone: "neutral", body: "No guardian is set on PolarisCheckout on this network, so nothing pauses Pay in 4." },
  unavailable: { title: "The guard couldn't be read", tone: "neutral", body: "The chain didn't answer just now. PolarisCheckout treats an unreadable guard as open, and so does this page." },
};

const DOT: Record<"lime" | "amber" | "neutral", string> = { lime: "bg-ui-lime", amber: "bg-ui-warn", neutral: "bg-ui-muted" };

function GuardPanel({ guard }: { guard: CreditGuard }) {
  const now = useNow(5_000);
  const age = guardAgeSeconds(guard, now);
  const max = guard.maxAgeSeconds;
  const state =
    guard.mismatch && !guard.paused
      ? { title: "Pay in 4 is open", tone: "neutral" as const, body: "PolarisCheckout asks another guardian than the one this dashboard reads, and it isn't pausing Pay in 4 now." }
      : STATE[guard.state];
  const feed = guard.priceFeed;
  const mainnetExplorer = feed?.chainId === 143 ? `https://monadvision.com/address/${feed.address}` : null;
  const lifted = guard.reasons.includes("owner_pause")
    ? "Polaris lifts it by hand."
    : guard.reasons.includes("bad_debt")
      ? "Bad debt never falls: Polaris acknowledges it by hand, and only new losses count after that."
      : "It opens again as soon as the check passes.";
  return (
    <Panel title="Risk guard" subtitle="polaris-guardian: whether new Pay in 4 plans may open">
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

      {age !== null && max ? (
        <div className="mt-6 grid gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-[14px]">
            <span>Last checked {checkedAgo(age)}</span>
            <span className="text-ui-muted">Stale after {Math.round(max / 60)} min, then the price check fails open</span>
          </div>
          <Meter
            value={age / max}
            tone={age > max ? "amber" : age > max * 0.75 ? "amber" : "lime"}
            label="Time since the guard's last check, of the time it allows"
            valueText={`${Math.round(age / 60)} minutes of ${Math.round(max / 60)}`}
          />
        </div>
      ) : null}

      {guard.checks.length ? (
        <>
          <p className="mt-6 mb-3 text-[13px] text-ui-muted">
            Against today&apos;s thresholds: the price from the latest CRE attestation, the cash and bad debt from the pool itself, read on every Pay in 4
          </p>
          <CheckList
            aria-label="The guardian's checks"
            items={guard.checks.map((c) => ({ key: c.key, label: `${c.label} (${c.source === "pool" ? "pool, live" : "CRE attestation"})`, value: c.value, limit: c.limit, ok: c.ok }))}
          />
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
          PolarisCheckout asks another guardian ({guard.mismatch.checkoutGuardian}) than the one this dashboard reads ({guard.mismatch.configuredGuardian}). Pay in 4
          follows the checkout&apos;s own answer; update the deployment record the API reads to see why.
        </p>
      ) : null}

      {feed && guard.attestation ? (
        <p className="mt-5 border-t border-ui-hairline-strong pt-4 text-[13px] leading-relaxed text-ui-muted">
          {feed.kind === "chainlink" ? (
            <>
              The price is Chainlink&apos;s {feed.description} on Monad mainnet, read by the workflow: round{" "}
              <span className="ui-figure text-ui-text">{guard.attestation.priceRoundId}</span>
              {guard.attestation.priceUpdatedAt ? `, updated ${formatAgo(guard.attestation.priceUpdatedAt, now)}` : ""}, feed{" "}
              <TxLink hash={feed.address} href={mainnetExplorer} kind="price feed" />.
            </>
          ) : (
            <>The price comes from a local stand-in feed ({feed.description}), not Chainlink: this is a local chain.</>
          )}
        </p>
      ) : null}
    </Panel>
  );
}

/* ── The pool, read as a feed ───────────────────────────────────────────── */

const READ_SNIPPET = (address: string) => `// GuardianReceiver is an AggregatorV3Interface: read it like any price feed.
const [roundId, answer, , updatedAt] = await client.readContract({
  address: "${address}",
  abi: aggregatorV3InterfaceAbi,
  functionName: "latestRoundData",
});
// answer: dollars the pool can lend now, 8 decimals (0 while credit is paused)`;

function FeedPanel({ guard, explorer }: { guard: CreditGuard; explorer: string | null }) {
  const now = useNow(15_000);
  const feed = guard.feed;
  const hasRound = feed && feed.roundId !== "0";
  return (
    <Panel title="Pool health feed" subtitle="GuardianReceiver.latestRoundData()">
      {!feed ? (
        <p className="mt-4 text-[14px] leading-relaxed text-ui-muted">No guardian is deployed on this network, so there is no feed to read.</p>
      ) : (
        <>
          <p className="mt-5 text-[13px] text-ui-muted">What the pool can lend now</p>
          <p className="ui-figure mt-1 text-[36px] leading-none font-medium tracking-[-0.035em]">{hasRound ? `$${feed.answerUsd}` : "No round yet"}</p>
          <dl className="mt-5 grid gap-2.5 text-[14px]">
            <Row label="Description" value={feed.description} />
            <Row label="Round" value={hasRound ? feed.roundId : "0"} />
            <Row label="Updated" value={feed.updatedAt ? formatAgo(feed.updatedAt, now) : "Never"} />
            <Row label="Decimals" value={String(feed.decimals)} />
            <Row label="Contract" value={<TxLink hash={feed.address} href={explorer ? `${explorer}/address/${feed.address}` : null} kind="contract" />} />
          </dl>
          <p className="mt-4 text-[13px] leading-relaxed text-ui-muted">
            The pool&apos;s free cash when the report landed (read from the pool, not the report), at the attested AUSD/USD price; 0 while the
            verdict pauses credit. Computed by our CRE workflow; it is a Polaris attestation, not a Chainlink Data Feed or Proof of Reserve.
          </p>
          <CodeBlock className="mt-4" aria-label="Reading the pool health feed" note="viem" samples={[{ key: "ts", label: "TypeScript", code: READ_SNIPPET(feed.address) }]} />
        </>
      )}
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
  cron: <Clock />,
  "evm-log": <Radio />,
  http: <Globe />,
};

function tagFor(key: WorkflowKey, run: ChainlinkRun): { tag: string; tone: StatusPillTone } {
  if (key === "collections" && run.collections) {
    const c = run.collections;
    if (c.afterReauthorization) return { tag: "Instant retry", tone: "purple" };
    if (c.collected || c.charged) return { tag: "Collected", tone: "lime" };
    if (c.liquidated) return { tag: "Closed", tone: "amber" };
    if (c.skipped) return { tag: "Dunned", tone: "amber" };
    return { tag: "Checked", tone: "neutral" };
  }
  if (key === "underwrite" && run.underwrite) return run.underwrite.applied ? { tag: "Line opened", tone: "purple" } : { tag: "Refused", tone: "amber" };
  if (key === "guardian" && run.guardian) {
    if (!run.guardian.accepted) return { tag: "Refused", tone: "red" };
    return run.guardian.creditPaused ? { tag: "Paused", tone: "amber" } : { tag: "Healthy", tone: "teal" };
  }
  return { tag: "Report", tone: "neutral" };
}

function WorkflowPanel({ workflow: w, localRun }: { workflow: ChainlinkWorkflow; localRun: boolean }) {
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
      title={<span className="ui-figure">{w.name}</span>}
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
                  <span className="font-medium">{t.label} trigger</span>
                  <span className="block text-ui-muted">{t.detail}</span>
                  {t.kind === "cron" && t.schedule ? <NextTick schedule={t.schedule} now={now} /> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2.5">
            <Figure label="Last report" value={w.lastRunAt ? ago(w.lastRunAt, now) : "None yet"} />
            <Figure label="Last 24 hours" value={`${w.runs24h.toLocaleString("en-US")} ${w.runs24h === 1 ? "report" : "reports"}`} />
          </div>
          {w.workflowId ? (
            <p className="ui-figure truncate text-[12.5px] text-ui-muted" title={w.workflowId}>
              Workflow id {w.workflowId.slice(0, 10)}…{w.workflowId.slice(-6)}
            </p>
          ) : null}
        </div>
        <RunList
          aria-label={`${w.name}: latest reports`}
          items={items}
          empty={
            <div className="grid place-items-center rounded-[18px] border border-dashed border-ui-hairline-strong px-6 py-10 text-center">
              <p className="text-[15px] font-medium">No reports yet</p>
              <p className="mt-1 max-w-[420px] text-[13.5px] leading-relaxed text-ui-muted">
                {localRun ? (
                  <>They appear here as soon as the workflow&rsquo;s local run writes one to the receiver.</>
                ) : (
                  <>
                    They appear here as soon as <span className="ui-figure">cre workflow simulate --broadcast</span> or the deployed workflow writes one to
                    the receiver.
                  </>
                )}
              </p>
            </div>
          }
        />
      </div>
    </Panel>
  );
}

/** When the cron fires next, on this browser's clock (the server's nextAt is only as fresh as the last read). */
function NextTick({ schedule, now }: { schedule: string; now: number }) {
  const next = nextCronFire(schedule, now);
  if (!next) return null;
  return <span className="ui-figure block text-[12.5px] text-ui-muted">Next on schedule {inTime(new Date(next).toISOString(), now)}</span>;
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

function inTime(iso: string, now: number): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return "now";
  if (s < 90) return `in ${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
}

