"use client";

import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { AlertIcon, CheckIcon, ExternalIcon, Spinner, WalletIcon } from "@/components/icons";
import { getProduct } from "@/lib/catalog";
import { fetchOrder } from "@/lib/checkout-client";
import { formatUsd } from "@/lib/money";
import type { Order } from "@/lib/orders/types";
import { PolarisLockup } from "@/components/polaris-lockup";
import { chainFor } from "@/lib/polaris-client";
import { useShop } from "@/lib/shop-context";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const DATE_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

const synced = new Set<string>();

const MODE_LABEL: Record<string, string> = { now: "Pay now", later: "Pay in 4", subscribe: "Subscription", direct: "Direct wallet payment" };

export function OrderView({
  initial,
  fromPolaris,
  fromCheckout,
  checkoutOrigin,
}: {
  initial: Order;
  fromPolaris: boolean;
  fromCheckout: boolean;
  /** The hosted Polaris app, where the buyer manages plans and subscriptions. null when payments aren't configured. */
  checkoutOrigin: string | null;
}) {
  const [order, setOrder] = useState(initial);
  const [session, setSession] = useState<{ status: string; mode: string | null } | null>(null);
  const { setCurrentOrderId, clear, ready } = useShop();
  const reduce = useReducedMotion();

  useEffect(() => setCurrentOrderId(initial.id), [initial.id, setCurrentOrderId]);

  // A receipt always opens at its top, with the confirmation in view.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  // Straight from checkout: the bag was this order, so empty it once the order is paid.
  const paidNow = order.status === "paid";
  useEffect(() => {
    if (ready && paidNow && fromCheckout && initial.kind === "one_time") clear();
  }, [ready, paidNow, fromCheckout, initial.kind, clear]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const started = Date.now();
    let first = true;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        // Ask Polaris for the session once per page load (StrictMode runs effects twice in dev).
        const sync = first && fromPolaris && !synced.has(initial.id);
        if (sync) synced.add(initial.id);
        const latest = await fetchOrder(initial.id, sync);
        if (latest && !stopped) {
          setOrder(latest.order);
          if (latest.session) setSession(latest.session);
        }
        first = false;
        const o = latest?.order;
        const live = o?.status === "awaiting_payment" || o?.plan?.status === "active" || o?.plan?.status === "past_due" || o?.subscription?.status === "active";
        if (!live || Date.now() - started > 10 * 60_000) return;
        timer = window.setTimeout(tick, o?.status === "awaiting_payment" ? 1200 : 4000);
        return;
      }
      timer = window.setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [initial.id, fromPolaris]);

  // A receipt opened without this browser's access cookie has no name or address in it.
  const firstName = order.redacted ? null : (order.address.name.split(/\s+/)[0] ?? order.address.name);
  const paid = order.status === "paid";
  const sessionDead = session && (session.status === "expired" || session.status === "canceled");

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-10 sm:px-6 lg:px-10 lg:pt-16">
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-7">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={order.status}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              aria-live="polite"
            >
              {paid ? (
                <>
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-ok text-paper">
                    <CheckIcon size={24} strokeWidth={2} />
                  </span>
                  <h1 className="display mt-6 text-[3rem] leading-[1] sm:text-[4.2rem]">{firstName ? `Thank you, ${firstName}.` : "Thank you."}</h1>
                  <p className="mt-4 max-w-[34rem] text-[1.08rem] leading-relaxed text-ink-2">
                    {order.kind === "subscription"
                      ? `Your Coffee Club subscription has started. The first bag ships this week, and we'll email ${order.contact.email} with tracking.`
                      : `Order ${order.number} is confirmed. We'll email ${order.contact.email} when it ships.`}
                  </p>
                </>
              ) : order.status === "needs_review" ? (
                <>
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-alert-soft text-alert">
                    <AlertIcon size={24} />
                  </span>
                  <h1 className="display mt-6 text-[3rem] leading-[1] sm:text-[4rem]">We&rsquo;re checking your payment.</h1>
                  <p className="mt-4 max-w-[34rem] text-[1.05rem] leading-relaxed text-ink-2">
                    The payment we received doesn&rsquo;t match this order, so we&rsquo;ve paused it before anything ships. We&rsquo;ll be in touch at{" "}
                    {order.contact.email}.
                  </p>
                  {order.statusReason ? <p className="mt-3 text-[0.92rem] text-muted">{order.statusReason}</p> : null}
                </>
              ) : sessionDead ? (
                <>
                  <h1 className="display text-[3rem] leading-[1] sm:text-[4rem]">This order isn&rsquo;t paid.</h1>
                  <p className="mt-4 max-w-[34rem] text-[1.05rem] text-ink-2">The Polaris checkout for it was {session?.status}. Nothing was charged.</p>
                  <Link href="/checkout" className="btn btn-ink mt-8">
                    Back to checkout
                  </Link>
                </>
              ) : (
                <>
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-sand text-ink">
                    <Spinner size={22} />
                  </span>
                  <h1 className="display mt-6 text-[3rem] leading-[1] sm:text-[4rem]">Confirming your payment…</h1>
                  <p className="mt-4 max-w-[34rem] text-[1.05rem] leading-relaxed text-ink-2">
                    {session?.status === "complete"
                      ? "Polaris has your payment. We're waiting for its confirmation to reach Halcyon, which takes a second or two."
                      : "This page updates by itself as soon as Polaris confirms the payment with Halcyon."}
                  </p>
                </>
              )}
            </motion.div>
          </AnimatePresence>

          <dl className="mt-10 grid grid-cols-2 gap-6 border-y border-hair py-6 text-[0.95rem] sm:grid-cols-3">
            <div>
              <dt className="text-muted">Order</dt>
              <dd className="num mt-0.5 font-medium">{order.number}</dd>
            </div>
            <div>
              <dt className="text-muted">Placed</dt>
              <dd className="mt-0.5" suppressHydrationWarning>{DATE.format(new Date(order.createdAt))}</dd>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <dt className="text-muted">Total</dt>
              <dd className="num mt-0.5">
                {formatUsd(order.total)}
                {order.kind === "subscription" ? <span className="text-muted"> a month</span> : null}
              </dd>
              {order.plan?.total && order.plan.interest ? (
                <dd className="num mt-0.5 text-[0.85rem] text-muted">
                  Plan total {formatUsd(order.plan.total)} incl. {formatUsd(order.plan.interest)} interest
                </dd>
              ) : null}
            </div>
          </dl>

          <PaymentBlock order={order} checkoutOrigin={checkoutOrigin} />

          <Timeline order={order} />
        </div>

        <aside className="lg:col-span-5">
          <div className="rounded-[4px] bg-paper p-6 shadow-[0_1px_0_var(--color-hair)] sm:p-8 lg:sticky lg:top-24">
            <h2 className="display text-[1.7rem]">Items</h2>
            <ul className="mt-5 space-y-4">
              {order.lines.map((line) => (
                <li key={`${line.productId}:${line.optionId}`} className="flex items-center gap-4">
                  <div className="tile relative h-[72px] w-[60px] shrink-0 overflow-hidden rounded-[3px]">
                    <Image src={line.image} alt="" fill sizes="60px" className="object-cover" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link href={`/products/${getProduct(line.productId)?.slug ?? ""}`} className="font-medium hover:underline">
                      {line.name}
                    </Link>
                    <p className="text-[0.88rem] text-muted">
                      {line.optionValue}
                      {line.quantity > 1 ? ` · ${line.quantity} × ${formatUsd(line.unitPrice)}` : ""}
                    </p>
                  </div>
                  <p className="num">{formatUsd(line.unitPrice * line.quantity)}</p>
                </li>
              ))}
            </ul>
            <dl className="mt-6 space-y-2.5 border-t border-hair pt-5 text-[0.95rem]">
              <div className="flex justify-between">
                <dt className="text-ink-2">Subtotal</dt>
                <dd className="num">{formatUsd(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-2">Delivery</dt>
                <dd className="num">{order.shipping === 0 ? "Free" : formatUsd(order.shipping)}</dd>
              </div>
              <div className="flex justify-between border-t border-hair pt-4 text-[1.08rem] font-medium">
                <dt>Total</dt>
                <dd className="num">{formatUsd(order.total)}</dd>
              </div>
            </dl>
            {order.redacted ? (
              <p className="mt-8 border-t border-hair pt-6 text-[0.88rem] text-muted">
                Open this receipt in the browser you ordered from to see the delivery details.
              </p>
            ) : (
            <div className="mt-8 border-t border-hair pt-6 text-[0.93rem]">
              <h3 className="font-medium">Delivering to</h3>
              <address className="mt-2 not-italic leading-relaxed text-ink-2">
                {order.address.name}
                <br />
                {order.address.line1}
                {order.address.line2 ? (
                  <>
                    , {order.address.line2}
                  </>
                ) : null}
                <br />
                {order.address.postalCode} {order.address.city}
                <br />
                {order.address.country}
              </address>
            </div>
            )}
            <Link href="/shop" className="btn btn-line mt-8 w-full">
              Continue shopping
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Timeline({ order }: { order: Order }) {
  const paid = order.status === "paid";
  const steps = [
    { label: "Order placed", detail: `${DATE_SHORT.format(new Date(order.createdAt))}, ${TIME.format(new Date(order.createdAt))}`, done: true },
    {
      label: "Payment confirmed",
      detail: paid && order.payment.paidAt ? `${TIME.format(new Date(order.payment.paidAt))}, confirmed by Polaris` : "Waiting for Polaris",
      done: paid,
    },
    { label: order.kind === "subscription" ? "Roasting your first bag" : "Preparing your order", detail: "Usually within a day", done: false },
    { label: "On its way", detail: "We'll email you tracking", done: false },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="mt-10 grid gap-0 sm:grid-cols-4" aria-label="Order progress">
      {steps.map((step, i) => (
        <li key={step.label} className="relative flex gap-4 pb-6 sm:block sm:pb-0 sm:pr-4">
          <div className="flex flex-col items-center sm:flex-row">
            <span
              className={`relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full ${
                step.done ? "bg-ok text-paper" : i === current ? "bg-ink text-paper" : "bg-ground shadow-[inset_0_0_0_1.5px_var(--color-hair-strong)]"
              }`}
            >
              {step.done ? <CheckIcon size={13} strokeWidth={2.2} /> : i === current && order.status === "awaiting_payment" ? <Spinner size={12} /> : null}
            </span>
            {i < steps.length - 1 ? (
              <span className={`w-px flex-1 sm:h-px sm:w-auto ${step.done ? "bg-ok" : "bg-hair-strong"} absolute left-3 top-6 bottom-0 sm:static sm:ml-2`} />
            ) : null}
          </div>
          <div className="sm:mt-3">
            <p className={`text-[0.95rem] font-medium ${step.done || i === current ? "text-ink" : "text-faint"}`}>{step.label}</p>
            <p className="text-[0.85rem] text-muted" suppressHydrationWarning>{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function short(value: string, head = 6, tail = 4) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function PaymentBlock({ order, checkoutOrigin }: { order: Order; checkoutOrigin: string | null }) {
  const { polarisConfig } = useShop();
  // Where a receipt's transaction can be seen: Monad testnet's explorer, or none on a local chain.
  const explorer = chainFor(polarisConfig).explorer;
  const paid = order.status === "paid";
  const manageUrl = checkoutOrigin ? `${checkoutOrigin}/insights?view=plans` : null;

  const mode = order.payment.mode ?? (order.payment.method === "wallet" ? "direct" : order.payment.requestedMode);
  const plan = order.plan;
  const sub = order.subscription;
  const collected = plan?.installments.filter((i) => i.status === "paid").length ?? 0;
  const nextDue = plan?.installments.find((i) => i.status !== "paid");
  const planTotal = plan ? (plan.total ?? plan.installments.reduce((n, i) => n + i.amount, 0)) : 0;

  return (
    <section aria-labelledby="payment-heading" className="mt-8 rounded-2xl bg-paper p-6 shadow-[inset_0_0_0_1px_var(--color-hair)] sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="payment-heading" className="flex items-center gap-2.5 text-[1.05rem]">
          {order.payment.method === "wallet" ? (
            <>
              <WalletIcon size={20} /> <span className="font-medium">Paid directly from a wallet</span>
              <span className="text-muted">· sent gas-free by</span>
              <PolarisLockup className="-ml-1 text-[1rem]" />
            </>
          ) : (
            <>
              <PolarisLockup className="text-[1.08rem]" />
              <span className="text-muted">· {mode ? MODE_LABEL[mode] : "Checkout"}</span>
            </>
          )}
        </h2>
        <span
          className={`rounded-full px-3 py-1 text-[0.8rem] font-medium ${
            paid ? "bg-ok-soft text-ok" : order.status === "needs_review" ? "bg-alert-soft text-alert" : "bg-sand text-ink-2"
          }`}
        >
          {paid ? "Paid" : order.status === "needs_review" ? "Under review" : "Awaiting confirmation"}
        </span>
      </div>

      {plan ? (
        <div className="mt-6">
          <div className="flex items-baseline justify-between">
            <p className="text-[0.95rem] text-ink-2" suppressHydrationWarning>
              {plan.status === "completed"
                ? "All four payments made."
                : plan.status === "past_due"
                  ? "A payment was missed; Polaris will retry."
                  : `${collected} of ${plan.installments.length} paid${nextDue ? ` · next ${DATE_SHORT.format(new Date(nextDue.dueAt))}` : ""}`}
            </p>
            <p className="num text-[0.9rem] text-muted">
              {plan.interest ? `${formatUsd(planTotal)} incl. ${formatUsd(plan.interest)} interest` : `${formatUsd(planTotal)} in total`}
            </p>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5" aria-hidden="true">
            {plan.installments.map((inst) => (
              <motion.span
                key={inst.index}
                className={`h-1.5 rounded-full ${inst.status === "paid" ? "bg-ok" : inst.status === "failed" ? "bg-alert" : "bg-hair-strong"}`}
                layout
              />
            ))}
          </div>
          <ol className="mt-5 divide-y divide-hair">
            {plan.installments.map((inst) => (
              <li key={inst.index} className="flex items-center justify-between py-3 text-[0.95rem]">
                <span className="flex items-center gap-3">
                  <span className="num w-5 text-muted">{inst.index}</span>
                  <span suppressHydrationWarning>{DATE.format(new Date(inst.dueAt))}</span>
                </span>
                <span className="flex items-center gap-4">
                  <span className="num">{formatUsd(inst.amount)}</span>
                  <span
                    className={`w-[5.5rem] rounded-full px-2 py-0.5 text-center text-[0.78rem] ${
                      inst.status === "paid" ? "bg-ok-soft text-ok" : inst.status === "failed" ? "bg-alert-soft text-alert" : "bg-sand text-ink-2"
                    }`}
                  >
                    {inst.status === "paid" ? "Paid" : inst.status === "failed" ? "Missed" : inst.status === "due" ? "Due" : "Upcoming"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[0.88rem] text-muted">
            Halcyon was paid {formatUsd(order.total)} in full when you ordered. Nothing was taken from you then; Polaris collects each
            payment automatically, a week apart.
          </p>
          {manageUrl ? (
            <a href={manageUrl} target="_blank" rel="noreferrer" className="link mt-3 inline-flex min-h-11 items-center gap-1.5 text-[0.92rem]">
              See this plan in Polaris <ExternalIcon size={14} />
            </a>
          ) : null}
        </div>
      ) : sub ? (
        <dl className="mt-6 grid gap-4 text-[0.95rem] sm:grid-cols-3">
          <div>
            <dt className="text-muted">Plan</dt>
            <dd className="num mt-0.5">{formatUsd(order.total)} a month</dd>
          </div>
          <div>
            <dt className="text-muted">{sub.status === "canceled" ? "Canceled" : "Next charge"}</dt>
            <dd className="mt-0.5" suppressHydrationWarning>{DATE.format(new Date(sub.status === "canceled" && sub.canceledAt ? sub.canceledAt : sub.nextChargeAt))}</dd>
          </div>
          <div>
            <dt className="text-muted">Charged so far</dt>
            <dd className="num mt-0.5">
              {sub.periodsCharged} {sub.periodsCharged === 1 ? "month" : "months"}
            </dd>
          </div>
          {sub.status === "active" && manageUrl ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 sm:col-span-3">
              <a href={manageUrl} target="_blank" rel="noreferrer" className="link inline-flex min-h-11 items-center gap-1.5 text-[0.92rem]">
                Skip or cancel in Polaris <ExternalIcon size={14} />
              </a>
            </div>
          ) : null}
        </dl>
      ) : paid ? (
        <dl className="mt-6 grid gap-4 text-[0.95rem] sm:grid-cols-3">
          <div>
            <dt className="text-muted">Amount</dt>
            <dd className="num mt-0.5">{formatUsd(order.total)}</dd>
          </div>
          <div>
            <dt className="text-muted">Paid</dt>
            <dd className="mt-0.5" suppressHydrationWarning>{order.payment.paidAt ? `${DATE_SHORT.format(new Date(order.payment.paidAt))}, ${TIME.format(new Date(order.payment.paidAt))}` : "Just now"}</dd>
          </div>
          {order.payment.method === "wallet" && order.payment.payer ? (
            <div>
              <dt className="text-muted">From</dt>
              <dd className="num mt-0.5 font-mono text-[0.88rem]">{short(order.payment.payer)}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="mt-5 flex items-center gap-2.5 text-[0.95rem] text-muted">
          <Spinner size={16} /> {order.payment.method === "wallet" ? "Waiting for the payment to land on Monad." : "Waiting for Polaris to confirm."}
        </p>
      )}

      {order.payment.refundDue ? (
        <p className="mt-5 flex gap-2.5 rounded-lg bg-alert-soft px-3.5 py-3 text-[0.9rem] text-alert" role="status">
          <AlertIcon size={18} className="mt-px shrink-0" />
          A second payment arrived for this order after it was paid. Halcyon will refund it to you.
        </p>
      ) : null}

      {order.payment.txHash ? (
        <p className="mt-5 border-t border-hair pt-4 text-[0.88rem] text-muted">
          {!explorer ? (
            <>Transaction {short(order.payment.txHash, 10, 6)} (a local chain, no explorer)</>
          ) : (
            <a href={`${explorer}/tx/${order.payment.txHash}`} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1.5">
              View receipt on the explorer <ExternalIcon size={14} />
            </a>
          )}
        </p>
      ) : null}
    </section>
  );
}
