"use client";

import {
  DeltaChip,
  DetailsList,
  EmptyState,
  KeyValueGrid,
  type KeyValue,
  ListGroup,
  ListRow,
  Money,
  PrimaryButton,
  SecondaryButton,
  StatusPill,
  TextTabs,
  Ticks,
} from "@polaris/ui";
import { AlertCircle, ArrowLeft, BadgeCheck, Link2Off, LockKeyhole, ScanFace, TrendingUp, Zap } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { MerchantAvatar } from "@/components/avatars";
import { BringHistorySheet } from "@/components/bring-history";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { GuardPausedNotice, GuardStaleLine } from "@/components/credit-guard-note";
import { LocalEquivalent } from "@/components/local-equivalent";
import { useCloseSheet } from "@/components/shell/sheet-host";
import { type PayMode, payLink } from "@/lib/actions";
import { useAccountState, useOwner } from "@/lib/account/hooks";
import { describeDuration, describeInterval, dueAt, getBalance, getCreditLine, type PaymentLink } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { longDate, shortDate } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { LINK_GONE_TEXT, type LinkGone } from "@/lib/link-gone";
import { usd } from "@/lib/money";
import { useNow } from "@/lib/use-now";
import { n, subscribeSummary } from "@/lib/view";
import { initialMode, laterPaused, MODE_LABEL, merchantLine, modesOf, type Paid, Receipt } from "@/sheets/checkout";

/**
 * A payment link from 1024px: one centred card on the framed canvas, under
 * the wordmark only. On the left the merchant and the order, on the right how
 * to pay (Pay now, Pay in 4 with its four dated payments, or Subscribe) and
 * the lime button that asks for Face ID. A shop's popup window is narrow, so
 * it keeps the phone checkout.
 */
export function CheckoutDesktop({ link }: { link: PaymentLink }) {
  const close = useCloseSheet();
  const state = useAccountState();
  const owner = useOwner();
  const balance = useData(() => getBalance(owner), [owner]);
  const credit = useData(() => getCreditLine(owner), [owner]);
  const now = useNow();
  const modes = modesOf(link);
  // The first mode the link offers, Pay now when it can, as on the phone.
  const [mode, setMode] = useState<PayMode>(() => initialMode(link));
  const [confirming, setConfirming] = useState(false);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [raising, setRaising] = useState(false);
  const id = useId();

  useEffect(() => prefetchDomains("ausd", "payments", "checkout"), []);

  const later = link.modes.later;
  const sub = link.modes.subscription;
  const paused = laterPaused(link);
  const available = balance.value?.available;
  const needFor = (m: PayMode) => (m === "now" ? link.amount : m === "later" ? 0n : (sub?.price ?? link.amount));
  const short = available !== undefined && state.status !== "none" && available < needFor(mode);
  const overLimit = mode === "later" && later && credit.value ? credit.value.available < later.total : false;
  // Pay in 4 waits for the credit line, so a fast click can't skip Raise your limit.
  const creditPending = mode === "later" && Boolean(later) && credit.value === undefined;
  const payDate = (i: number) => (later && now ? shortDate(dueAt(now, later.interval, i)) : "");
  const each = later ? usd(later.amounts[0] ?? 0n) : "";
  const signedIn = available !== undefined && state.status !== "none";

  const title =
    mode === "later" && paused ? "Pay in 4 is paused" : mode === "later" && later ? "Start Pay in 4" : mode === "subscription" && sub ? `Subscribe for ${usd(sub.price)}` : `Pay ${usd(link.amount, { trim: true })}`;

  const numbers: KeyValue[] =
    mode === "later" && later
      ? [
          { label: "Interest", value: usd(later.interest) },
          { label: "Due today", value: usd(0n) },
          { label: "In total", value: usd(later.total) },
          { label: "Rate", value: `${later.aprBps / 100}% a year` },
        ]
      : mode === "subscription" && sub
        ? [
            { label: "Price", value: usd(sub.price) },
            { label: "Billed", value: describeInterval(sub.periodSeconds).replace(/^every /, "Every ") },
            { label: "First charge", value: "Today" },
            { label: "Cancel", value: "Any time" },
          ]
        : [
            { label: "You pay today", value: usd(link.amount) },
            { label: "Interest", value: usd(0n) },
            { label: "Network fee", value: "None" },
            { label: "From", value: signedIn ? usd(available) : "Your dollars" },
          ];

  return (
    <div className="mx-auto w-full max-w-[1040px] pt-2">
      {/* One height for every mode, so switching tabs never jumps the card. */}
      <div className="grid min-h-[728px] grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] overflow-hidden rounded-[32px] border border-ui-hairline-strong xl:min-h-[744px]">
        {/* The order */}
        <section aria-label="The order" className="flex flex-col p-8 xl:p-10">
          <div className="flex items-center gap-4">
            <MerchantAvatar name={link.merchant.name} size="lg" />
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[22px] leading-tight font-medium tracking-[-0.02em]">
                <span className="truncate">{link.merchant.name}</span>
                <BadgeCheck aria-label="Verified business" size={20} strokeWidth={1.75} className="shrink-0 text-ui-lime-text" />
              </p>
              <p className="mt-1 truncate text-[15px] text-ui-muted">
                {merchantLine(link) || "Verified business"}
              </p>
            </div>
          </div>

          <p className="mt-10 text-[14px] text-ui-muted">Total</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Money value={n(link.amount)} className="ui-figure text-[56px] leading-none font-medium tracking-[-0.04em]" />
            {later ? <DeltaChip value={null} label={`or 4 × ${each}`} /> : sub ? <DeltaChip value={null} label="Monthly" /> : null}
          </div>
          <LocalEquivalent amount={link.amount} className="mt-3 block text-[15px]" />

          <DetailsList
            className="mt-8"
            items={[
              { label: "For", value: link.description },
              ...(link.session ? [] : [{ label: "Order", value: link.orderId }]),
              { label: "Merchant", value: [link.merchant.name, link.merchant.city].filter(Boolean).join(", ") },
              {
                label: `${link.merchant.name} gets`,
                value: mode === "subscription" && sub ? `${usd(sub.price)} today` : `${usd(link.amount)} today, in full`,
              },
            ]}
          />

          <ListGroup className="mt-6">
            <ListRow icon={<ScanFace />} tone="tint-lime" title="One Face ID to pay" description="No card number, no password" />
            <ListRow icon={<Zap />} tone="tint-teal" title="Lands in under a second" description={`${link.merchant.name} sees it straight away`} />
          </ListGroup>

          <p className="mt-auto flex items-start gap-2 pt-6 text-[13px] leading-relaxed text-ui-muted">
            <LockKeyhole aria-hidden size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" />
            Every payment asks for your Face ID. {link.merchant.name} is paid in full the moment you confirm.
          </p>
        </section>

        {/* How to pay */}
        <section aria-label="How to pay" className="flex flex-col gap-4 bg-ui-surface-1/40 p-8 xl:p-10">
          {modes.length > 1 ? (
            <TextTabs
              aria-label="How to pay"
              size="md"
              options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
              value={mode}
              onValueChange={setMode}
              tabId={(v) => `${id}-tab-${v}`}
              panelId={() => `${id}-panel`}
            />
          ) : (
            <p className="text-[16px] leading-none font-semibold tracking-[0.01em] text-ui-lime-active uppercase">{MODE_LABEL[modes[0] ?? "now"]}</p>
          )}

          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${mode}`} className="grid gap-4">
            {mode === "later" && paused ? (
              <GuardPausedNotice message={paused} />
            ) : mode === "later" && later ? (
              <div className="rounded-ui-swap bg-ui-surface-1 p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="ui-figure text-[34px] leading-none font-medium tracking-[-0.03em]">4 × {each}</p>
                  <StatusPill tone="purple" size="sm">
                    Nothing today
                  </StatusPill>
                </div>
                <Ticks done={0} total={later.installments} className="mt-4" />
                <ol className="mt-4 grid gap-2.5">
                  {later.amounts.map((amount, i) => (
                    <li key={i} className="flex items-center gap-3 text-[15px]">
                      <span className="ui-figure grid size-7 shrink-0 place-items-center rounded-full bg-ui-surface-2 text-[12px] font-semibold">{i + 1}</span>
                      <span className="flex-1 text-ui-muted">{now ? longDate(dueAt(now, later.interval, i)) : "…"}</span>
                      <span className="ui-figure">{usd(amount)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : mode === "subscription" && sub ? (
              <div className="rounded-ui-swap bg-ui-surface-1 p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="ui-figure text-[34px] leading-none font-medium tracking-[-0.03em]">
                    {usd(sub.price)}
                    <span className="text-[18px] text-ui-muted"> {describeInterval(sub.periodSeconds)}</span>
                  </p>
                  <StatusPill tone="teal" size="sm">
                    Cancel any time
                  </StatusPill>
                </div>
                <p className="mt-2 text-[14px] text-ui-muted">{sub.name}</p>
                <ol className="mt-4 grid gap-2.5">
                  {[0, 1, 2, 3].map((i) => (
                    <li key={i} className="flex items-center gap-3 text-[15px]">
                      <span className="ui-figure grid size-7 shrink-0 place-items-center rounded-full bg-ui-surface-2 text-[12px] font-semibold">{i + 1}</span>
                      <span className="flex-1 text-ui-muted">{i === 0 ? "Today" : now ? longDate(now + i * sub.periodSeconds * 1000) : "…"}</span>
                      <span className="ui-figure">{usd(sub.price)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <div className="rounded-ui-swap bg-ui-surface-1 p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="ui-figure text-[34px] leading-none font-medium tracking-[-0.03em]">{usd(link.amount)}</p>
                  <StatusPill tone="lime" size="sm">
                    Paid in full
                  </StatusPill>
                </div>
                <p className="mt-2 text-[14px] text-ui-muted">Once, from your dollar account</p>
                <dl className="mt-4 grid gap-2.5 text-[15px]">
                  {[
                    { label: "Your balance now", value: signedIn ? usd(available) : "Your dollars" },
                    { label: "After this payment", value: signedIn && available >= link.amount ? usd(available - link.amount) : "…" },
                    { label: `${link.merchant.name} has it`, value: "In under a second" },
                    { label: "Your receipt", value: "In Activity, right away" },
                  ].map((r) => (
                    <div key={r.label} className="flex items-center justify-between gap-3">
                      <dt className="text-ui-muted">{r.label}</dt>
                      <dd className="ui-figure">{r.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {mode === "later" && paused ? null : <KeyValueGrid items={numbers} />}

            {mode === "later" && later && credit.value ? (
              overLimit ? (
                <p role="status" className="flex items-start gap-2 text-[14px] leading-snug text-ui-warn">
                  <AlertCircle aria-hidden size={18} strokeWidth={1.75} className="mt-px shrink-0" />
                  This plan needs {usd(later.total)} of limit and you have {usd(credit.value.available)}. Pay now, or raise your limit.
                </p>
              ) : (
                <p className="text-[14px] leading-snug text-ui-muted">
                  First payment in {describeDuration(later.interval)} ({payDate(0)}), then {describeInterval(later.interval)}. Your Pay later limit:{" "}
                  <span className="ui-figure text-ui-text">{usd(credit.value.available)}</span> of {usd(credit.value.limit, { trim: true })}.
                </p>
              )
            ) : null}
            {mode === "later" && later ? <GuardStaleLine guard={link.session?.creditGuard} /> : null}
            {mode === "later" && paused ? (
              <p className="text-[14px] leading-snug text-ui-muted">
                Plans you already have keep going as scheduled. Pay in 4 comes back here as soon as the risk guard lifts the pause.
              </p>
            ) : mode === "subscription" && sub ? (
              <p className="text-[14px] leading-snug text-ui-muted">
                Charged {describeInterval(sub.periodSeconds)} from your dollar account until you cancel, which you can do any time in Pay in 4.
              </p>
            ) : mode === "now" ? (
              <p className="text-[14px] leading-snug text-ui-muted">No interest and no fees. The receipt is in Activity the moment it lands.</p>
            ) : null}
            {short ? (
              <p role="status" className="text-[14px] text-ui-down">
                Not enough dollars in your account for this.{later && mode !== "later" ? " Try Pay in 4." : ""}
              </p>
            ) : null}
          </div>

          <div className="mt-auto grid gap-3 pt-2">
            <PrimaryButton size="lg" block icon={<ScanFace />} disabled={short || overLimit || creditPending || (mode === "later" && paused !== null)} onClick={() => setConfirming(true)}>
              {title}
            </PrimaryButton>
            {mode === "later" && paused && link.modes.now ? (
              <SecondaryButton size="lg" block onClick={() => setMode("now")}>
                Pay now instead, {usd(link.amount)}
              </SecondaryButton>
            ) : mode === "later" && credit.value && !credit.value.historyLinked ? (
              <SecondaryButton size="lg" block iconRight={<TrendingUp />} onClick={() => setRaising(true)}>
                Raise your limit
              </SecondaryButton>
            ) : mode === "now" && later ? (
              <SecondaryButton size="lg" block onClick={() => setMode("later")}>
                Or Pay in 4: 4 × {each}, nothing today
              </SecondaryButton>
            ) : mode === "now" && sub ? (
              <SecondaryButton size="lg" block onClick={() => setMode("subscription")}>
                Or subscribe, {usd(sub.price)} {describeInterval(sub.periodSeconds)}
              </SecondaryButton>
            ) : mode === "subscription" && link.modes.now ? (
              <SecondaryButton size="lg" block onClick={() => setMode("now")}>
                Or pay once, {usd(link.amount)}
              </SecondaryButton>
            ) : null}
          </div>
        </section>
      </div>
      <div className="mt-4 flex justify-center">
        <button type="button" onClick={close} className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[15px] text-ui-muted transition-colors hover:text-ui-text">
          <ArrowLeft aria-hidden size={16} strokeWidth={1.75} />
          Cancel and go back
        </button>
      </div>

      <ConfirmSheet
        open={confirming}
        onOpenChange={setConfirming}
        title={title}
        summary={
          mode === "later" && later
            ? `${later.installments} × ${each} to ${link.merchant.name}, the first on ${payDate(0)}. Nothing to pay today. ${usd(later.interest)} interest in total.`
            : mode === "subscription" && sub
              ? subscribeSummary(link, sub)
              : `To ${link.merchant.name}, from your dollar account.`
        }
        newLabel="Pay with Face ID"
        busyLabel="Paying…"
        onAccount={async (signer) => {
          const receipt = await payLink(signer, link, mode, { outstanding: credit.value?.used ?? 0n });
          setPaid({ mode, receipt, at: Date.now() });
        }}
      />
      {paid ? <Receipt link={link} paid={paid} onDone={close} /> : null}
      <BringHistorySheet open={raising} onOpenChange={setRaising} credit={credit.value} />
    </div>
  );
}

/** A link that doesn't resolve, on the same card, saying why when the API said (turned off, expired, paid). */
export function CheckoutMissing({ gone }: { gone?: LinkGone | null }) {
  const text = LINK_GONE_TEXT[gone ?? "not_found"];
  return (
    <div className="mx-auto grid w-full max-w-[560px] justify-items-center rounded-[32px] border border-ui-hairline-strong p-10">
      <EmptyState
        icon={<Link2Off />}
        title={text.title}
        description={text.description}
        action={
          <PrimaryButton asChild size="md">
            <Link href="/">Go to Polaris</Link>
          </PrimaryButton>
        }
      />
    </div>
  );
}
