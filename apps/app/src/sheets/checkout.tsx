"use client";

import {
  Badge,
  Button,
  Card,
  DetailsList,
  EmptyState,
  IconButton,
  type KeyValue,
  KeyValueGrid,
  Money,
  ScreenHeader,
  SegmentedControl,
  Sheet,
  toast,
} from "@polaris/ui";
import { AlertCircle, BadgeCheck, CircleCheck, Clock, Link2Off, Share2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MerchantAvatar } from "@/components/avatars";
import { BringHistorySheet } from "@/components/bring-history";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { GuardPausedNotice, GuardStaleLine } from "@/components/credit-guard-note";
import { LocalEquivalent } from "@/components/local-equivalent";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { SuccessSheet } from "@/components/success-sheet";
import { CheckoutDesktop, CheckoutMissing } from "@/desktop/checkout";
import { LINK_GONE_TEXT, type LinkGone } from "@/lib/link-gone";
import { type PayMode, payLink } from "@/lib/actions";
import { useAccountState, useOwner } from "@/lib/account/hooks";
import { laterPausedMessage } from "@/lib/credit-guard";
import { announceReady, cancelCheckout, expireCheckout, isPopupCheckout, merchantReturnUrl, postCompleted, returnToMerchant } from "@/lib/checkout-return";
import { describeDuration, describeInterval, dueAt, getBalance, getCreditLine, type PaymentLink } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { shortDate } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import { useNow } from "@/lib/use-now";
import { n, subscribeSummary } from "@/lib/view";

export type Paid = { mode: PayMode; receipt: RelayReceipt; at: number };

export const MODE_LABEL: Record<PayMode, string> = { now: "Pay now", later: "Pay in 4", subscription: "Subscribe" };

/** "Studio · Lisbon", from what is known about the merchant (a real session carries neither). */
export function merchantLine(link: PaymentLink): string {
  return [link.merchant.category, link.merchant.city].filter(Boolean).join(" · ");
}

/** The mode a checkout opens on: the one the merchant's page chose, when the link offers it (and Pay in 4 isn't paused). */
export function initialMode(link: PaymentLink): PayMode {
  const modes = modesOf(link).filter((m) => !(m === "later" && laterPaused(link)));
  const preferred = link.session?.preferredMode;
  return preferred && modes.includes(preferred) ? preferred : (modes[0] ?? "now");
}

/** Why Pay in 4 is shown but can't be chosen: the risk guard (the Chainlink CRE guardian) has paused new plans. */
export const laterPaused = laterPausedMessage;

export function modesOf(link: PaymentLink): PayMode[] {
  const modes: PayMode[] = [];
  if (link.modes.now) modes.push("now");
  if (link.modes.later || laterPaused(link)) modes.push("later");
  if (link.modes.subscription) modes.push("subscription");
  return modes;
}

/** Checkout /pay/[id] (full), on ref C's trade screen and ref B: the merchant, the numbers, Pay in 4 or Pay now. */
export function CheckoutSheet({ link }: { link: PaymentLink }) {
  const close = useCloseSheet();
  const state = useAccountState();
  const owner = useOwner();
  const balance = useData(() => getBalance(owner), [owner]);
  const credit = useData(() => getCreditLine(owner), [owner]);
  const now = useNow();
  const modes = modesOf(link);
  const [mode, setMode] = useState<PayMode>(() => initialMode(link));
  const [confirming, setConfirming] = useState<PayMode | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [raising, setRaising] = useState(false);

  // Read the signing domains now, so Confirm goes straight to Face ID.
  useEffect(() => prefetchDomains("ausd", "payments", "checkout"), []);

  const later = link.modes.later;
  const sub = link.modes.subscription;
  const paused = laterPaused(link);
  const available = balance.value?.available;
  // What leaves the dollar account today. Pay in 4 takes nothing at checkout:
  // the merchant is paid from the credit pool, the first payment is a week on.
  const needFor = (m: PayMode) => (m === "now" ? link.amount : m === "later" ? 0n : (sub?.price ?? link.amount));
  const short = (m: PayMode) => available !== undefined && state.status !== "none" && available < needFor(m);
  const overLimit = later && credit.value ? credit.value.available < later.total : false;
  // Pay in 4 waits for the credit line: until it loads, "over the limit" is
  // unknown, and a fast tap must not skip Raise your limit.
  const creditPending = Boolean(later) && credit.value === undefined;
  // Payment i falls due (i + 1) intervals after the plan opens (PolarisLoanEngine.installmentDueAt).
  const payDate = (i: number) => (later && now ? shortDate(dueAt(now, later.interval, i)) : "");
  const each = later ? usd(later.amounts[0] ?? 0n) : "";

  const grid: KeyValue[] =
    mode === "later" && later
      ? [
          { label: "Pay in 4", value: `${each} × ${later.installments}` },
          { label: "Interest", value: usd(later.interest) },
          { label: "First payment", value: payDate(0) || "In a week" },
          { label: "Due today", value: usd(0n) },
        ]
      : mode === "subscription" && sub
        ? [
            { label: "Price", value: usd(sub.price) },
            { label: "Billed", value: describeInterval(sub.periodSeconds).replace(/^every /, "Every ") },
            { label: "First charge", value: "Today" },
            { label: "Cancel", value: "Any time" },
          ]
        : [
            { label: "Amount", value: usd(link.amount) },
            { label: "You pay today", value: usd(link.amount) },
            { label: "Interest", value: usd(0n) },
            { label: "Network fee", value: "None" },
          ];

  const details: KeyValue[] = [
    {
      label: "Merchant",
      value: (
        <span className="inline-flex items-center gap-1.5">
          {link.merchant.name}
          <BadgeCheck aria-label="Verified business" size={16} strokeWidth={1.75} className="text-ui-lime" />
        </span>
      ),
    },
    { label: "For", value: link.description },
    // A merchant's checkout names its order in the description ("Halcyon order HC-39073"); the internal ref shows only for a link without a session.
    ...(link.session ? [] : [{ label: "Order", value: link.orderId }]),
  ];
  if (mode === "later" && later && now) {
    const ORDINAL = ["First", "Second", "Third"];
    later.amounts.forEach((amount, i) => {
      const label = i === later.amounts.length - 1 ? "Last payment" : ORDINAL[i] ? `${ORDINAL[i]} payment` : `Payment ${i + 1}`;
      details.push({ label, value: `${usd(amount)} · ${payDate(i)}` });
    });
  } else if (mode === "now") {
    details.push({
      label: "From",
      value: available !== undefined && state.status !== "none" ? `Dollar account · ${usd(available)}` : "Your dollar account",
    });
  }
  // Pay now says it in its tiles; Pay in 4 and Subscribe say it here. Polaris's relayer pays the gas for every step.
  if (mode !== "now") details.push({ label: "Network fee", value: "None, Polaris pays it" });

  async function share() {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: `Pay ${link.merchant.name}`, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied", tone: "success" });
    } catch {
      toast({ title: "Couldn't copy the link", tone: "error" });
    }
  }

  // The footer follows the chosen mode: its purple button, then Pay now beside it.
  const other = mode !== "now" ? mode : modes.find((m) => m !== "now");
  const actions: PayMode[] =
    modes.length === 1 ? modes : [...(other ? [other] : []), ...(modes.includes("now") ? (["now"] as const) : [])];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        variant="arrow"
        title={link.merchant.name}
        subtitle={merchantLine(link) || "Verified business"}
        onBack={close}
        action={<IconButton label="Share this link" icon={<Share2 />} tone="ink" onClick={() => void share()} />}
        className="-mt-2 shrink-0 px-5"
      />
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
        <Card variant="raised" radius="tile" padding="md">
          <div className="flex items-center gap-4">
            <MerchantAvatar name={link.merchant.name} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] text-ui-muted">Total</p>
              <Money value={n(link.amount)} dim="cents" className="mt-1 text-[36px] leading-none font-semibold tracking-[-0.03em]" />
            </div>
            {later ? <Badge tone="lime">Pay in 4</Badge> : sub ? <Badge tone="purple">Monthly</Badge> : null}
          </div>
          {/* Under the whole row: the badge leaves the figure's column too narrow for it. */}
          <LocalEquivalent amount={link.amount} className="mt-3 block text-[13px]" />
        </Card>

        {modes.length > 1 ? (
          <Card variant="raised" radius="tile" padding="md" className="flex items-center justify-between gap-3">
            <span className="text-[16px] text-ui-muted">Pay</span>
            <SegmentedControl
              aria-label="How to pay"
              value={mode}
              onValueChange={setMode}
              options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
            />
          </Card>
        ) : null}

        {mode === "later" && paused ? (
          <GuardPausedNotice message={paused} onPayNow={link.modes.now ? () => setMode("now") : undefined} payNowLabel={`Pay ${usd(link.amount, { trim: true })} now`} />
        ) : (
          <KeyValueGrid items={grid} />
        )}
        <DetailsList items={details} />

        {mode === "later" && later && credit.value ? (
          <Card variant="raised" radius="tile" padding="md" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[16px] font-medium">Your Pay later limit</span>
              <span className="ui-figure text-[15px]">
                {usd(credit.value.available)} <span className="text-ui-muted">of {usd(credit.value.limit, { trim: true })}</span>
              </span>
            </div>
            {overLimit ? (
              <p role="status" className="flex items-start gap-2 text-[14px] leading-snug text-ui-warn">
                <AlertCircle aria-hidden size={18} strokeWidth={1.75} className="mt-px shrink-0" />
                This plan needs {usd(later.total)} of limit. Pay now, or raise your limit.
              </p>
            ) : (
              <p className="text-[14px] leading-snug text-ui-muted">
                First payment in {describeDuration(later.interval)}, then {describeInterval(later.interval)}. {later.aprBps / 100}% a
                year, {usd(later.total)} in total.
              </p>
            )}
            <GuardStaleLine guard={link.session?.creditGuard} />
            {!credit.value.historyLinked ? (
              <Button variant="outline" size="md" icon={<TrendingUp />} onClick={() => setRaising(true)}>
                Raise your limit
              </Button>
            ) : null}
          </Card>
        ) : null}

        {short(mode) ? (
          <p role="status" className="text-center text-[14px] text-ui-down">
            Not enough dollars in your account for this.{later && mode !== "later" ? " Try Pay in 4." : ""}
          </p>
        ) : null}
      </Sheet.Body>
      <Sheet.Footer>
        {actions.map((m) => (
          <Button
            key={m}
            variant={m === "now" ? "lime" : "purple"}
            size="lg"
            disabled={short(m) || (m === "later" && (paused !== null || creditPending))}
            onClick={() => {
              setMode(m);
              // Over the limit, Pay in 4 first shows the limit and the way to raise it.
              if (m === "later" && overLimit) setRaising(true);
              else setConfirming(m);
            }}
          >
            {actions.length === 1 ? `${MODE_LABEL[m]} ${usd(needFor(m), { trim: true })}` : MODE_LABEL[m]}
          </Button>
        ))}
      </Sheet.Footer>

      <ConfirmSheet
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={
          confirming === "later" && later
            ? "Start Pay in 4"
            : confirming === "subscription" && sub
              ? `Subscribe for ${usd(sub.price)}`
              : `Pay ${usd(link.amount, { trim: true })}`
        }
        summary={
          confirming === "later" && later
            ? `${later.installments} × ${each} to ${link.merchant.name}, the first on ${payDate(0)}. Nothing to pay today. ${usd(later.interest)} interest in total.`
            : confirming === "subscription" && sub
              ? subscribeSummary(link, sub)
              : `To ${link.merchant.name}, from your dollar account.`
        }
        newLabel="Pay with Face ID"
        busyLabel="Paying…"
        onAccount={async (signer) => {
          const m = confirming ?? mode;
          const receipt = await payLink(signer, link, m, { outstanding: credit.value?.used ?? 0n });
          setPaid({ mode: m, receipt, at: Date.now() });
        }}
      />

      {paid ? <Receipt link={link} paid={paid} onDone={close} /> : null}
      <BringHistorySheet open={raising} onOpenChange={setRaising} credit={credit.value} />
    </div>
  );
}

export function Receipt({ link, paid, onDone }: { link: PaymentLink; paid: Paid; onDone: () => void }) {
  const later = link.modes.later;
  const sub = link.modes.subscription;

  // Tell the merchant's page that opened us, and only that page (polarispay-sdk's
  // v1 protocol, lib/checkout-return.ts), the moment the payment is final.
  const told = useRef(false);
  useEffect(() => {
    if (told.current) return;
    told.current = true;
    postCompleted(link, paid.mode, paid.receipt);
  }, [link, paid]);
  // A popup has done its job once its opener knows: it closes itself after a moment on the receipt.
  useEffect(() => {
    if (!link.session || !isPopupCheckout() || !window.opener) return;
    const timer = window.setTimeout(() => returnToMerchant(link), 2500);
    return () => window.clearTimeout(timer);
  }, [link]);

  // The plan opened when the relayer's block was final; payment 1 is one interval later.
  const firstDate = later ? shortDate(dueAt(paid.at, later.interval, 0)) : "";
  const each = later ? usd(later.amounts[0] ?? 0n) : "";
  const subtitle =
    paid.mode === "later" && later
      ? `${link.merchant.name} is paid. Your first payment of ${each} is on ${firstDate}.`
      : paid.mode === "subscription" && sub
        ? `Subscribed to ${link.merchant.name}. Next charge in ${describeDuration(sub.periodSeconds)}.`
        : `${usd(link.amount)} to ${link.merchant.name}.`;

  const rows: KeyValue[] = [{ label: "For", value: link.description }];
  if (paid.mode === "later" && later) {
    rows.push({ label: "First payment", value: `${each} · ${firstDate}` }, { label: "Plan", value: `${later.installments} × ${each}` });
  } else if (paid.mode === "subscription" && sub) {
    rows.push({ label: "Paid today", value: usd(sub.price) }, { label: "Then", value: `${usd(sub.price)} ${describeInterval(sub.periodSeconds)}` });
  } else {
    rows.push({ label: "Paid", value: usd(link.amount) });
  }
  if (!link.session) rows.push({ label: "Order", value: link.orderId });

  const done = () => {
    if (!returnToMerchant(link)) onDone();
  };
  // A merchant's own page to go back to; a dashboard payment link has none, so the buyer is Done.
  const backTo = merchantReturnUrl(link);

  return (
    <SuccessSheet
      open
      onOpenChange={() => done()}
      title={paid.mode === "later" ? "Done." : "Paid."}
      subtitle={subtitle}
      rows={rows}
      receiptUrl={paid.receipt.explorerUrl}
      primary={{ label: backTo ? `Back to ${link.merchant.name}` : "Done", onClick: done }}
    />
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function CheckoutRoute({ link, gone, cold }: { cold?: boolean; gone?: LinkGone | null } & { link: PaymentLink | null }) {
  const router = useRouter();
  const successUrl = link ? merchantReturnUrl(link) : null;

  // The merchant's page that opened us learns the checkout is up (or that
  // the session had already expired), over polarispay-sdk's v1 protocol.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!link?.session || announced.current === link.id) return;
    announced.current = link.id;
    if (link.status === "expired" || link.session.expiresAt <= Date.now()) expireCheckout(link);
    else announceReady(link);
  }, [link]);

  // A buyer who backs out of a checkout they were sent to goes back where they
  // came from: the merchant's window that opened this one, or its page.
  const leave = useCallback(() => {
    // A real session tells its opener "canceled" and closes, or goes to its cancel page.
    if (link?.session && link.status === "open" && cancelCheckout(link)) return;
    if (window.opener) {
      window.close();
      // A browser that refuses to close the window leaves us here: go home.
      window.setTimeout(() => router.replace("/", { scroll: false }), 200);
    } else if (successUrl) {
      window.location.assign(successUrl);
    } else {
      router.replace("/", { scroll: false });
    }
  }, [router, successUrl, link]);
  return (
    <RouteSheet
      label={link ? `Pay ${link.merchant.name}` : "Payment link"}
      snapPoints={["full"]}
      cold={cold}
      onColdClose={leave}
      desktop={{
        as: "page",
        focus: true,
        content: !link ? <CheckoutMissing gone={gone} /> : link.status !== "open" ? <CheckoutClosed link={link} framed /> : <CheckoutDesktop link={link} />,
      }}
    >
      {link && link.status !== "open" ? (
        <Sheet.Body className="pt-10">
          <CheckoutClosed link={link} />
        </Sheet.Body>
      ) : link ? (
        <CheckoutSheet link={link} />
      ) : (
        <Sheet.Body className="pt-10">
          <EmptyState
            icon={<Link2Off />}
            title={LINK_GONE_TEXT[gone ?? "not_found"].title}
            description={LINK_GONE_TEXT[gone ?? "not_found"].description}
            action={
              <Button asChild variant="white" size="lg">
                <Link href="/">Go to Polaris</Link>
              </Button>
            }
          />
        </Sheet.Body>
      )}
    </RouteSheet>
  );
}

const noSubscribe = () => () => undefined;

/** A session that was already paid, or has expired: nothing to pay, and the way back. */
function CheckoutClosed({ link, framed }: { link: PaymentLink; framed?: boolean }) {
  const paid = link.status === "paid";
  // Read after hydration: the merchant's page, or none when the link came back to Polaris itself.
  const backTo = useSyncExternalStore(
    noSubscribe,
    () => merchantReturnUrl(link),
    () => link.successUrl,
  );
  const state = (
    <EmptyState
      icon={paid ? <CircleCheck /> : <Clock />}
      title={paid ? `${link.merchant.name} is already paid` : "This checkout has expired"}
      description={
        paid
          ? `${link.description}. Nothing more to pay here.`
          : `Nothing was charged. Go back to ${link.merchant.name} to start again.`
      }
      action={
        (paid ? backTo : (link.session?.cancelUrl ?? backTo)) ? (
          <Button
            variant="white"
            size="lg"
            onClick={() => {
              if (paid) returnToMerchant(link);
              else window.location.assign(link.session?.cancelUrl ?? backTo!);
            }}
          >
            Back to {link.merchant.name}
          </Button>
        ) : (
          <Button asChild variant="white" size="lg">
            <Link href="/">Go to Polaris</Link>
          </Button>
        )
      }
    />
  );
  return framed ? <div className="mx-auto grid w-full max-w-[560px] justify-items-center rounded-[32px] border border-ui-hairline-strong p-10">{state}</div> : state;
}
