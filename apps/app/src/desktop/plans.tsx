"use client";

import {
  BalanceSummaryCard,
  Coin,
  DataTable,
  DollarCoin,
  EmptyState,
  FigureRow,
  KeyValueGrid,
  Money,
  PanelCard,
  PrimaryButton,
  SecondaryButton,
  Sheet,
  Skeleton,
  StatusPill,
  TableName,
  Ticks,
  TimeframeChips,
} from "@polaris/ui";
import { CalendarClock, CalendarX, Check, Layers, Repeat } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MerchantAvatar } from "@/components/avatars";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { SignAgainCard } from "@/components/sign-again";
import { signAgainState } from "@/lib/collection";
import { SuccessSheet } from "@/components/success-sheet";
import { payEarly } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { describeInterval, dueAt, getCreditLine, getPlans, type Plan, quotePlan, type Subscription, WEEK } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { inDays, longDate, relativeDay, shortDate } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { dollars, type Micros, usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import { SubscriptionSheet } from "@/screens/plans-view";
import { n, planProgress } from "@/lib/view";
import { PageGrid, PageHead, SectionTitle, SideColumn, SideNote } from "./bits";

type Show = "all" | "open" | "done";

/** The "4" coin: Pay in 4, in the plans' purple. */
function FourCoin({ size = 50 }: { size?: number }) {
  return (
    <Coin tone="purple" size={size}>
      4
    </Coin>
  );
}

/**
 * Pay in 4 from 1024px, the merchant's Pay in 4 ledger seen from the buyer's
 * side: what is still to pay, every plan with its lime instalment ticks (a
 * plan opens its details in a Drawer, with Pay early), your subscriptions,
 * and on the right your Pay later line and how Pay in 4 works.
 */
export function PlansDesktop() {
  const router = useRouter();
  const owner = useOwner();
  const plans = useData(() => getPlans(owner), [owner]);
  const credit = useData(() => getCreditLine(owner), [owner]);
  const [show, setShow] = useState<Show>("all");
  const [managing, setManaging] = useState<Subscription | null>(null);

  useEffect(() => prefetchDomains("payments"), []);

  const all = plans.value?.plans ?? [];
  const open = all.filter((p) => p.status === "active");
  const done = all.filter((p) => p.status === "completed");
  const left = open.reduce((s, p) => s + planProgress(p).left, 0n);
  const rows = show === "open" ? open : show === "done" ? done : [...open, ...done];
  const subs = plans.value?.subscriptions ?? [];
  const next = credit.value?.nextPayment ?? null;
  const example = quotePlan(dollars(200), 4, WEEK, credit.value?.aprBps ?? 1000);

  return (
    <>
      <PageHead title="Pay in 4" coins={[<FourCoin key="4" />, <DollarCoin key="d" size={50} />]} />
      <PageGrid
        stack
        main={
          <>
            <FigureRow
              caption="Still to pay"
              value={plans.value ? <Money value={n(left)} /> : undefined}
              deltaLabel={plans.value ? `${open.length} open ${open.length === 1 ? "plan" : "plans"}` : undefined}
              right={
                <TimeframeChips<Show>
                  aria-label="Show"
                  options={[
                    { value: "all", label: `All ${all.length}` },
                    { value: "open", label: `Open ${open.length}` },
                    { value: "done", label: `Paid off ${done.length}` },
                  ]}
                  value={show}
                  onValueChange={setShow}
                />
              }
            />
            <p className="mt-3 max-w-[640px] text-[15px] leading-relaxed text-ui-muted">
              Each plan split a purchase into four payments, a week apart. Nothing was due at checkout, and paying early never costs extra.
            </p>

            <div className="mt-6">
              {plans.value && rows.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={<CalendarClock />}
                  title="No plans here"
                  description="Choose Pay in 4 at checkout. Every payment and the total interest are shown first."
                />
              ) : (
                <DataTable
                  caption="Your Pay in 4 plans"
                  loading={!plans.value}
                  loadingRows={4}
                  rows={rows}
                  rowKey={(p) => p.id}
                  onRowClick={(p) => router.push(`/plans/${p.id}`, { scroll: false })}
                  columns={[
                    {
                      key: "merchant",
                      header: "Merchant",
                      render: (p) => <TableName icon={<MerchantAvatar name={p.merchant.name} size="xs" />} title={p.merchant.name} sub={p.description} />,
                    },
                    {
                      key: "paid",
                      header: "Paid",
                      render: (p) => {
                        const pr = planProgress(p);
                        return (
                          <span className="flex items-center gap-3">
                            <Ticks done={pr.done} total={pr.total} size="sm" className="w-[96px]" />
                            <span className="ui-figure text-[13px] text-ui-muted">
                              {pr.done}/{pr.total}
                            </span>
                          </span>
                        );
                      },
                    },
                    {
                      key: "next",
                      header: "Next payment",
                      hideBelow: "xl",
                      render: (p) => {
                        const pr = planProgress(p);
                        return pr.next ? (
                          <span className="block">
                            <span className="ui-figure block">{usd(pr.next.amount)}</span>
                            <span className="block text-[13px] text-ui-muted">
                              {shortDate(pr.next.dueAt)}, {inDays(pr.next.dueAt)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-ui-muted">None</span>
                        );
                      },
                    },
                    {
                      key: "state",
                      header: "State",
                      render: (p) =>
                        p.status === "active" && signAgainState(p) === "needed" ? (
                          <StatusPill tone="amber">Sign again</StatusPill>
                        ) : p.status === "active" ? (
                          <StatusPill tone="purple">On track</StatusPill>
                        ) : (
                          <StatusPill tone="lime" icon={<Check />}>
                            Paid off
                          </StatusPill>
                        ),
                    },
                    {
                      key: "left",
                      header: "Left to pay",
                      align: "right",
                      render: (p) => (
                        <span className="block">
                          <span className="ui-figure block">{usd(planProgress(p).left)}</span>
                          <span className="block text-[13px] text-ui-muted">of {usd(p.principal + p.interest)}</span>
                        </span>
                      ),
                    },
                  ]}
                />
              )}
            </div>

            <SectionTitle className="mt-12">Subscriptions</SectionTitle>
            <div className="mt-3">
              {plans.value && subs.length === 0 ? (
                <EmptyState size="sm" icon={<Repeat />} title="No subscriptions" description="Subscribe from a merchant's link. Cancel here any time." />
              ) : (
                <DataTable
                  caption="Your subscriptions"
                  loading={!plans.value}
                  loadingRows={2}
                  rows={subs}
                  rowKey={(s) => s.id}
                  onRowClick={(s) => (s.status === "active" ? setManaging(s) : undefined)}
                  columns={[
                    { key: "merchant", header: "Merchant", render: (s) => <TableName icon={<MerchantAvatar name={s.merchant.name} size="xs" />} title={s.merchant.name} sub={s.name} /> },
                    { key: "price", header: "Price", render: (s) => <span className="ui-figure">{usd(s.price)} <span className="text-ui-muted">{describeInterval(s.periodSeconds)}</span></span> },
                    { key: "next", header: "Next charge", hideBelow: "xl", render: (s) => (s.status === "active" ? shortDate(s.nextChargeAt) : "None") },
                    {
                      key: "status",
                      header: "Status",
                      align: "right",
                      render: (s) => (s.status === "active" ? <StatusPill tone="teal">Active</StatusPill> : <StatusPill tone="neutral">Cancelled</StatusPill>),
                    },
                  ]}
                />
              )}
            </div>
          </>
        }
        side={
          <>
            <SideColumn>
              {credit.value ? (
                <BalanceSummaryCard
                  label="Pay later line"
                  value={<Money value={n(credit.value.available)} />}
                  badge={<StatusPill tone="lime" size="sm">{credit.value.aprBps / 100}% APR</StatusPill>}
                  stats={[
                    { label: "Your line", value: usd(credit.value.limit, { trim: true }) },
                    { label: "In use", value: usd(credit.value.used) },
                    { label: "Score", value: credit.value.score },
                  ]}
                />
              ) : (
                <Skeleton shape="card" height={170} />
              )}
              {next ? (
                <PrimaryButton asChild size="lg" block className="mt-1">
                  <Link href={`/plans/${next.planId}`} scroll={false}>
                    Pay {usd(next.amount)} early
                  </Link>
                </PrimaryButton>
              ) : null}
              <SecondaryButton asChild size="lg" block iconRight={<Layers />} className={next ? undefined : "mt-1"}>
                <Link href="/credit">Your credit line</Link>
              </SecondaryButton>
            </SideColumn>
            <SideColumn>
              <PanelCard title="How Pay in 4 works" padding="md">
                <div className="mt-4 rounded-[20px] bg-ui-surface-1 p-4">
                  <p className="text-[13px] text-ui-muted">A $200.00 order</p>
                  <p className="ui-figure mt-1 text-[28px] leading-tight font-medium tracking-[-0.02em]">4 × {usd(example.amounts[0] ?? 0n)}</p>
                  <Ticks done={0} total={4} className="mt-3" />
                  <p className="mt-3 text-[13px] leading-snug text-ui-muted">
                    Every 7 days · {example.aprBps / 100}% APR · {usd(example.interest)} interest · {usd(example.total)} in total
                  </p>
                </div>
                <ul className="mt-4 grid gap-2.5 text-[14px] leading-snug">
                  {[
                    "Nothing to pay at checkout: the first payment is a week later.",
                    "Every payment and the total interest are shown before you confirm.",
                    "Pay any payment early from its plan, at no extra cost.",
                  ].map((t) => (
                    <li key={t} className="flex gap-2.5">
                      <Check aria-hidden size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-ui-lime-text" />
                      {t}
                    </li>
                  ))}
                </ul>
              </PanelCard>
              <SideNote>Pay in 4 is 10% a year, worked out per plan: a $200 order is 4 × $50.38.</SideNote>
            </SideColumn>
          </>
        }
      />
      <SubscriptionSheet sub={managing} onClose={() => setManaging(null)} />
    </>
  );
}

/* ── The plan's Drawer ──────────────────────────────────────────────────── */

/**
 * A plan's details (the /plans/[id] route's Drawer): what it was, the ticks,
 * the numbers, the four payments with their dates, and Pay early.
 */
export function PlanDrawerContent({ id }: { id: string }) {
  const owner = useOwner();
  const plans = useData(() => getPlans(owner), [owner]);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState<{ receipt: RelayReceipt; amount: Micros } | null>(null);

  useEffect(() => prefetchDomains("payments"), []);

  if (!plans.value) {
    return (
      <Sheet.Body className="grid gap-3">
        <Skeleton shape="tile" height={64} />
        <Skeleton shape="tile" height={160} />
      </Sheet.Body>
    );
  }
  const plan: Plan | undefined = plans.value.plans.find((p) => p.id === id);
  if (!plan) {
    return (
      <Sheet.Body>
        <EmptyState size="sm" icon={<CalendarX />} title="This plan isn't here" description="It may belong to another account on this device." />
      </Sheet.Body>
    );
  }
  const p = planProgress(plan);
  const total = plan.principal + plan.interest;

  return (
    <>
      <Sheet.Body className="grid content-start gap-6">
        <SignAgainCard plan={plan} plans={plans.value.plans} />
        <div className="flex items-center gap-3">
          <MerchantAvatar name={plan.merchant.name} />
          <div className="min-w-0">
            <p className="truncate text-[18px] font-medium">{plan.merchant.name}</p>
            <p className="truncate text-[14px] text-ui-muted">{plan.description}</p>
          </div>
          {plan.status === "active" && signAgainState(plan) === "needed" ? (
            <StatusPill tone="amber" className="ml-auto">
              Sign again
            </StatusPill>
          ) : plan.status === "active" ? (
            <StatusPill tone="purple" className="ml-auto">
              On track
            </StatusPill>
          ) : (
            <StatusPill tone="lime" icon={<Check />} className="ml-auto">
              Paid off
            </StatusPill>
          )}
        </div>
        <div>
          <p className="text-[14px] text-ui-muted">Left to pay</p>
          <Money value={n(p.left)} className="ui-figure mt-1 block text-[40px] leading-none font-medium tracking-[-0.035em]" />
          <Ticks done={p.done} total={p.total} className="mt-4" />
          <p className="mt-2 text-[13px] text-ui-muted">
            {p.done} of {p.total} paid · {usd(total)} in total
          </p>
        </div>
        <KeyValueGrid
          items={[
            { label: "Amount", value: usd(plan.principal) },
            { label: "Pay in 4", value: `${usd(plan.instalments[0]?.amount ?? 0n)} × ${p.total}` },
            { label: "Interest", value: usd(plan.interest) },
            { label: "First payment", value: shortDate(plan.instalments[0]?.dueAt ?? dueAt(plan.openedAt, plan.interval, 0)) },
          ]}
        />
        <div>
          <h3 className="text-[14px] font-medium text-ui-muted">Payments</h3>
          <ol className="mt-2 grid">
            {plan.instalments.map((inst) => {
              const isNext = inst === p.next;
              return (
                <li key={inst.index} className="flex h-14 items-center gap-3 border-b border-ui-hairline last:border-b-0">
                  <span className="ui-figure grid size-8 shrink-0 place-items-center rounded-full bg-ui-surface-1 text-[13px] font-semibold">{inst.index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px]">{longDate(inst.dueAt)}</span>
                    <span className="block text-[13px] text-ui-muted">
                      {inst.paidAt !== null ? `Paid ${shortDate(inst.paidAt)}` : isNext ? `Next, ${inDays(inst.dueAt)}` : `Due ${inDays(inst.dueAt)}`}
                    </span>
                  </span>
                  <span className="ui-figure text-[15px]">{usd(inst.amount)}</span>
                  {inst.paidAt !== null ? (
                    <StatusPill tone="lime" size="sm">
                      Paid
                    </StatusPill>
                  ) : isNext ? (
                    <StatusPill tone="purple" size="sm">
                      Next
                    </StatusPill>
                  ) : (
                    <StatusPill tone="neutral" size="sm">
                      Scheduled
                    </StatusPill>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        <p className="text-[13px] leading-relaxed text-ui-muted">
          {describeInterval(plan.interval).replace(/^every/, "Every")}, opened {longDate(plan.openedAt)}. Paying early costs nothing extra and counts toward your score.
        </p>
      </Sheet.Body>
      {p.next ? (
        <Sheet.Footer className="[&>*]:flex-1">
          <PrimaryButton size="lg" onClick={() => setPaying(true)}>
            Pay {usd(p.next.amount)} early
          </PrimaryButton>
        </Sheet.Footer>
      ) : null}
      {p.next ? (
        <ConfirmSheet
          open={paying}
          onOpenChange={setPaying}
          title={`Pay ${usd(p.next.amount)} early`}
          summary={`Your next payment to ${plan.merchant.name}, due ${relativeDay(p.next.dueAt)}. Paying early costs nothing extra.`}
          busyLabel="Paying…"
          onAccount={async (signer) => {
            const amount = p.next!.amount;
            const receipt = await payEarly(signer, plan);
            setPaid({ receipt, amount });
          }}
        />
      ) : null}
      <SuccessSheet
        open={paid !== null}
        onOpenChange={(o) => !o && setPaid(null)}
        title="Paid early."
        subtitle={paid ? `${usd(paid.amount)} to ${plan.merchant.name}. ${n(p.left) > 0 ? `${usd(p.left)} left.` : "All paid off."}` : undefined}
        receiptUrl={paid?.receipt.explorerUrl}
      />
    </>
  );
}
