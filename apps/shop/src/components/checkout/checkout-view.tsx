"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { AlertIcon, CheckIcon, Spinner, WalletIcon } from "@/components/icons";
import { FLAT_SHIPPING, FREE_SHIPPING_THRESHOLD, getOption, getProduct } from "@/lib/catalog";
import { CheckoutError, fetchOrder, logBrowserCalls, newAttemptId, placeOrder, type CheckoutPayload } from "@/lib/checkout-client";
import { formatUsd } from "@/lib/money";
import { payIn4 } from "@/lib/pay-in-4";
import { PolarisCheckoutButton, chainFor, isPolarisError, type CheckoutResult, type PayResult, type PolarisError } from "@/lib/polaris-client";
import { pausedMessage } from "@/lib/polaris-config";
import { useShop } from "@/lib/shop-context";

import { ContactFields, ContactSummary, DEMO_BUYER, FIELD_NAMES, validateBuyer, type BuyerForm } from "./contact-fields";
import { OrderSummary, type SummaryLine } from "./order-summary";
import { PaymentOptions, type Method, type Mode } from "./payment-options";
import { ACTIVE_STEP, WalletSteps, type WalletPhase } from "./wallet-steps";

/** "top": under the Checkout heading, where a buyer lands. "inline": under the pay button, where they are. */
type Notice = { tone: "info" | "error"; text: string; at: "top" | "inline"; working?: boolean } | null;

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

const WALLET_LABEL: Partial<Record<WalletPhase, string>> = {
  connecting: "Connecting your wallet…",
  signing: "Confirm in your wallet…",
  submitting: "Sending, gas-free…",
  confirming: "Confirming on Monad…",
  waiting: "Waiting for Polaris…",
  paid: "Paid",
  error: "Try again",
};

function browserWallet(): Eip1193 | null {
  const eth = (window as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

/** "email", "email and full name", "email, city and postcode". */
function listFields(keys: string[]): string {
  const names = keys.map((k) => FIELD_NAMES[k] ?? "details");
  return names.length <= 1 ? (names[0] ?? "details") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function CheckoutView({
  subscription,
  returnedFromCancel,
}: {
  subscription: { productId: string; optionId: string } | null;
  returnedFromCancel: boolean;
}) {
  const shop = useShop();
  const router = useRouter();
  const { polaris, polarisConfig, setCurrentOrderId } = shop;
  // The network a wallet payment signs on: Monad testnet, or `pnpm demo:local`'s chain.
  const chain = useMemo(() => chainFor(polarisConfig), [polarisConfig]);
  const chainHex = `0x${chain.chainId.toString(16)}`;

  const lines: SummaryLine[] = useMemo(() => {
    if (subscription) {
      const product = getProduct(subscription.productId)!;
      const option = getOption(product, subscription.optionId)!;
      return [{ productId: product.id, optionId: option.id, quantity: 1, product, option, lineTotal: product.price }];
    }
    return shop.lines;
  }, [subscription, shop.lines]);

  const kind = subscription ? "subscription" : "one_time";
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const shipping = kind === "subscription" || subtotal === 0 || subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING;
  const total = subtotal + shipping;
  const aprBps = polarisConfig.payInFourAprBps;
  // Polaris's risk guard has paused Pay in 4: offer Pay now (and say why), never a plan that would be refused.
  const payInFourPaused = polarisConfig.ok ? pausedMessage(polarisConfig.creditGuard) : null;

  const [buyer, setBuyer] = useState<BuyerForm>(DEMO_BUYER);
  // Complete details show as one card, so the payment choice is in the first screen.
  const [editing, setEditing] = useState(() => Object.keys(validateBuyer(DEMO_BUYER)).length > 0);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<Method>("polaris");
  const [mode, setMode] = useState<Mode>(subscription ? "subscribe" : payInFourPaused ? "now" : "later");
  const [notice, setNotice] = useState<Notice>(
    returnedFromCancel ? { tone: "info", at: "top", text: "You left Polaris without paying. Nothing was charged, and your order is as you left it." } : null,
  );
  const [walletState, setWalletState] = useState<WalletPhase>("idle");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletStep, setWalletStep] = useState(0);
  const [needsSwitch, setNeedsSwitch] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [attemptId, setAttemptId] = useState(newAttemptId);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const sessionRef = useRef<{ orderId: string; url: string; openedAt: string } | null>(null);
  /** The unpaid order this browser is paying, so changing how to pay continues it instead of opening another. */
  const currentOrder = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    /* eslint-disable react-hooks/set-state-in-effect -- window.ethereum and the pointer only exist in the browser */
    setHasWallet(browserWallet() !== null);
    setCoarsePointer(window.matchMedia("(pointer: coarse)").matches);
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      alive.current = false;
    };
  }, []);

  // A notice under the pay button can land just below the fold: bring it into view.
  useEffect(() => {
    if (notice?.at !== "inline") return;
    const el = document.getElementById("checkout-notice");
    if (!el) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
  }, [notice]);

  const clientErrors = validateBuyer(buyer);
  const errors = { ...(touched ? clientErrors : {}), ...serverErrors };
  const valid = Object.keys(clientErrors).length === 0 && lines.length > 0;

  /** Open the fields, then take the buyer to the first one that needs another look. */
  const revealInvalid = useCallback(() => {
    setTouched(true);
    setEditing(true);
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const field = document.querySelector<HTMLElement>('[aria-invalid="true"]');
        if (!field) return;
        const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        field.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
        field.focus({ preventScroll: true });
      }),
    );
  }, []);

  const payload = useCallback(
    (payment: CheckoutPayload["payment"]): CheckoutPayload => ({
      items: lines.map((l) => ({ productId: l.productId, optionId: l.optionId, quantity: l.quantity })),
      contact: { email: buyer.email, ...(buyer.phone ? { phone: buyer.phone } : {}) },
      address: {
        name: buyer.name,
        line1: buyer.line1,
        ...(buyer.line2 ? { line2: buyer.line2 } : {}),
        city: buyer.city,
        postalCode: buyer.postalCode,
        country: buyer.country,
      },
      payment,
      ...(currentOrder.current ? { continueOrder: currentOrder.current } : {}),
    }),
    [lines, buyer],
  );

  const place = useCallback(
    async (payment: CheckoutPayload["payment"]) => {
      setServerErrors({});
      setNotice(null);
      try {
        const res = await placeOrder(payload(payment), attemptId);
        if (res.order.status === "awaiting_payment") currentOrder.current = res.order.id;
        return res;
      } catch (e) {
        if (e instanceof CheckoutError) {
          if (e.code === "idempotency_conflict") {
            const fresh = newAttemptId();
            setAttemptId(fresh);
            return placeOrder(payload(payment), fresh);
          }
          if (Object.keys(e.fields).length > 0) {
            setServerErrors(e.fields);
            revealInvalid();
          }
        }
        throw e;
      }
    },
    [payload, attemptId, revealInvalid],
  );

  const toReceipt = useCallback(
    (orderId: string, via: "polaris" | "wallet") => {
      // The receipt opens at its top, with the confirmation in view.
      window.scrollTo({ top: 0 });
      router.push(`/orders/${orderId}?via=${via}`);
    },
    [router],
  );

  const createSession = useCallback(async () => {
    const openedAt = new Date().toISOString();
    const res = await place({ method: "polaris", mode });
    if (res.order.status !== "awaiting_payment") {
      router.push(`/orders/${res.order.id}`);
      throw new CheckoutError("This order is already paid.", "already_paid");
    }
    if (!res.checkout) throw new CheckoutError("Polaris didn't return a checkout.", "no_session");
    sessionRef.current = { orderId: res.order.id, url: res.checkout.url, openedAt };
    setCurrentOrderId(res.order.id);
    return { id: res.checkout.sessionId, url: res.checkout.url };
  }, [place, mode, router, setCurrentOrderId]);

  /**
   * The Polaris window closed (or timed out) without telling us how it ended.
   * The buyer may have paid a moment before closing it, so ask the store,
   * which asks Polaris, before saying anything about money.
   */
  const settleAfterClose = useCallback(
    async (orderId: string) => {
      setNotice({ tone: "info", at: "inline", working: true, text: "Checking with Polaris…" });
      const check = async (sync: boolean): Promise<"paid" | "open" | "expired" | "unknown"> => {
        const latest = await fetchOrder(orderId, sync);
        if (!latest) return "unknown";
        if (latest.order.status === "paid" || latest.session?.status === "complete") return "paid";
        if (latest.session?.status === "open" || latest.session?.status === "expired") return latest.session.status;
        return "unknown";
      };
      const say = (verdict: "open" | "expired") =>
        setNotice({
          tone: "info",
          at: "inline",
          text:
            verdict === "open"
              ? "The Polaris window closed before you finished. Nothing was charged; you can pick up where you left off."
              : "That Polaris checkout expired. Nothing was charged; start again when you're ready.",
        });

      let verdict = await check(true);
      if (!alive.current) return;
      if (verdict === "paid") return toReceipt(orderId, "polaris");
      if (verdict !== "unknown") return say(verdict);

      setNotice({ tone: "info", at: "inline", working: true, text: "The Polaris window closed. If you finished paying, we'll confirm it here in a moment." });
      const started = Date.now();
      let lastSync = started;
      while (Date.now() - started < 30_000) {
        await sleep(1500);
        if (!alive.current) return;
        const sync = Date.now() - lastSync >= 10_000;
        if (sync) lastSync = Date.now();
        verdict = await check(sync);
        if (!alive.current) return;
        if (verdict === "paid") return toReceipt(orderId, "polaris");
        if (verdict !== "unknown") return say(verdict);
      }
      setNotice({
        tone: "info",
        at: "inline",
        text: "We haven't heard from Polaris yet. If you paid, your receipt will show it; otherwise you can try again.",
      });
    },
    [toReceipt],
  );

  const onCheckoutResult = useCallback(
    (result: CheckoutResult) => {
      const session = sessionRef.current;
      if (session) {
        logBrowserCalls(session.orderId, [{ at: session.openedAt, call: "polaris.openCheckout", args: [session.url], result }]);
      }
      if (result.status === "completed" && session) {
        // The receipt empties the bag once the order is paid.
        toReceipt(session.orderId, "polaris");
      } else if (result.status === "canceled") {
        setNotice({ tone: "info", at: "inline", text: "You canceled in Polaris. Nothing was charged. Choose another way to pay, or try again." });
      } else if ((result.status === "closed" || result.status === "expired" || result.status === "timeout") && session) {
        void settleAfterClose(session.orderId);
      }
    },
    [toReceipt, settleAfterClose],
  );

  const onCheckoutError = useCallback((e: PolarisError | Error) => {
    const cause = (e as { cause?: unknown }).cause ?? e;
    if ((cause instanceof CheckoutError && cause.code === "already_paid") || (e instanceof CheckoutError && e.code === "already_paid")) return;
    setNotice({
      tone: "error",
      at: "inline",
      text: isPolarisError(e) && e.type === "configuration_error" ? "Polaris isn't set up correctly on this store." : e.message,
    });
  }, []);

  const moveWallet = useCallback((phase: WalletPhase) => {
    setWalletState(phase);
    const step = ACTIVE_STEP[phase];
    if (step !== undefined) setWalletStep(step);
  }, []);

  const walletMessage = useCallback(
    (result: { error?: string; cause?: unknown }): string => {
      const code = (result.cause as { code?: unknown } | undefined)?.code;
      if (code === "no_wallet") {
        return coarsePointer
          ? "We couldn't find a wallet in this browser. Open this page in your wallet app's browser, or pay with Polaris above."
          : "We couldn't find a wallet in this browser. Install one such as MetaMask or Rabby, or pay with Polaris above.";
      }
      if (code === 4001 || /cancell?ed the request|user rejected|user denied/i.test(result.error ?? "")) {
        return "You canceled in your wallet. Nothing was charged.";
      }
      return result.error ?? "The payment didn't go through. Nothing was charged.";
    },
    [coarsePointer],
  );

  /**
   * Direct wallet payment: the store creates the order (its payRef is what
   * the buyer signs for), then polaris.pay() asks the wallet for one ERC-3009
   * signature and the Polaris relayer submits it. Paid still only comes from
   * the webhook.
   */
  const payFromWallet = useCallback(async () => {
    if (!polaris) return;
    if (!valid) {
      revealInvalid();
      return;
    }
    const eth = browserWallet();
    setWalletError(null);
    setNeedsSwitch(false);
    if (!eth) {
      moveWallet("error");
      setWalletError(walletMessage({ cause: { code: "no_wallet" } }));
      return;
    }
    moveWallet("connecting");
    // On another network: say so, and offer the switch, before the wallet or the store is asked for anything.
    try {
      const chainId = await eth.request({ method: "eth_chainId" });
      if (typeof chainId === "string" && chainId.toLowerCase() !== chainHex) {
        moveWallet("idle");
        setNeedsSwitch(true);
        return;
      }
    } catch {
      // The SDK asks again, and handles what the wallet says.
    }

    let res;
    try {
      res = await place({ method: "wallet" });
    } catch (e) {
      moveWallet("error");
      setWalletError((e as Error).message);
      return;
    }
    if (!res.wallet) {
      if (res.order.status !== "awaiting_payment") router.push(`/orders/${res.order.id}`);
      moveWallet("error");
      setWalletError("This order can't be paid from a wallet.");
      return;
    }
    const { merchant, amount, orderId: payRef } = res.wallet;
    const orderId = res.order.id;
    setCurrentOrderId(orderId);
    const startedAt = new Date().toISOString();

    let result: PayResult;
    try {
      result = await polaris.pay({ merchant, amount, orderId: payRef, onStage: (stage) => moveWallet(stage) });
    } catch (e) {
      // Setup mistakes throw (an undeployed contract); the buyer's own problems come back as a result.
      result = { ok: false, error: (e as Error).message, cause: e };
    }
    logBrowserCalls(orderId, [
      {
        at: startedAt,
        call: "polaris.pay",
        args: [{ merchant, amount, orderId: payRef }],
        result: result.ok
          ? { ok: true, transactionHash: result.transactionHash, paymentId: result.paymentId, relayed: result.relayed }
          : { ok: false, error: result.error },
      },
    ]);
    if (!alive.current) return;
    if (!result.ok) {
      if ((result.cause as { code?: unknown } | undefined)?.code === "wrong_chain") {
        moveWallet("idle");
        setNeedsSwitch(true);
        return;
      }
      moveWallet("error");
      setWalletError(walletMessage(result));
      return;
    }

    moveWallet("waiting");
    // Paid comes from the webhook, never from here: wait for the store to hear it.
    for (let i = 0; i < 90; i++) {
      const latest = await fetchOrder(orderId);
      if (!alive.current) return;
      if (latest?.order.status === "paid") {
        moveWallet("paid");
        window.setTimeout(() => toReceipt(orderId, "wallet"), 1600);
        return;
      }
      await sleep(1000);
    }
    toReceipt(orderId, "wallet");
  }, [polaris, valid, revealInvalid, place, router, setCurrentOrderId, moveWallet, walletMessage, toReceipt, chainHex]);

  /** Switch the wallet to Monad Testnet (adding it if the wallet has never seen it), then carry on paying. */
  const switchNetwork = useCallback(async () => {
    const eth = browserWallet();
    if (!eth) return;
    setSwitching(true);
    setWalletError(null);
    try {
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      } catch (e) {
        if ((e as { code?: unknown }).code !== 4902) throw e;
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chainHex,
              chainName: chain.name,
              rpcUrls: [chain.rpcUrl],
              ...(chain.explorer ? { blockExplorerUrls: [chain.explorer] } : {}),
              nativeCurrency: chain.nativeCurrency,
            },
          ],
        });
      }
    } catch {
      if (alive.current) {
        setSwitching(false);
        setWalletError(`Your wallet stayed on the other network. Switch to ${chain.name} in your wallet, then try again.`);
      }
      return;
    }
    if (!alive.current) return;
    setSwitching(false);
    setNeedsSwitch(false);
    void payFromWallet();
  }, [payFromWallet, chain, chainHex]);

  const onPolarisClickCapture = useCallback(
    (e: MouseEvent) => {
      if (valid) return;
      // Keep the Polaris window from opening, and show what needs fixing.
      e.stopPropagation();
      e.preventDefault();
      revealInvalid();
    },
    [valid, revealInvalid],
  );

  const topNotice =
    notice?.at === "top" ? (
      <p id="checkout-notice" role="status" className="mt-5 flex gap-3 rounded-xl bg-sand p-4 text-[0.95rem] text-ink-2">
        <AlertIcon size={20} className="mt-0.5 shrink-0" />
        {notice.text}
      </p>
    ) : null;

  if (!shop.ready && !subscription) {
    return (
      <div className="mx-auto max-w-[1440px] px-4 pt-8 sm:px-6 lg:px-10 lg:pt-14" aria-busy="true">
        <h1 className="display text-[2.8rem] sm:text-[3.6rem]">Checkout</h1>
      </div>
    );
  }

  if (shop.ready && lines.length === 0) {
    return (
      <div className="mx-auto max-w-[1440px] px-4 pt-16 sm:px-6 lg:px-10">
        <h1 className="display text-[3rem] sm:text-[4rem]">Checkout</h1>
        {topNotice}
        <p className="mt-4 text-muted">Your bag is empty.</p>
        <Link href="/shop" className="btn btn-ink mt-8">
          Shop the collection
        </Link>
      </div>
    );
  }

  const testMode = polarisConfig.ok && polarisConfig.publishableKey.startsWith("pk_test_");
  const walletBusy = walletState !== "idle" && walletState !== "error" && walletState !== "paid";
  const plan = payIn4(total, aprBps);
  const polarisLabel =
    mode === "later" && plan
      ? `Pay in 4 · ${formatUsd(plan.each)} a week`
      : mode === "subscribe"
        ? `Subscribe · ${formatUsd(total)} a month`
        : `Pay ${formatUsd(total)} with Polaris`;
  const noWallet = hasWallet === false;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-8 sm:px-6 lg:px-10 lg:pt-8">
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="display text-[2.8rem] sm:text-[3.6rem]">Checkout</h1>
            {testMode ? <span className="rounded-full bg-sand px-3 py-1 text-[0.8rem] text-ink-2">Test mode · no real money moves</span> : null}
          </div>
          {topNotice}

          <div className="mt-6 lg:hidden">
            <OrderSummary lines={lines} subtotal={subtotal} shipping={shipping} total={total} mode={method === "polaris" ? mode : null} aprBps={aprBps} collapsible />
          </div>

          <form noValidate onSubmit={(e) => e.preventDefault()} className="mt-6" aria-describedby={notice ? "checkout-notice" : undefined}>
            {editing ? (
              <ContactFields
                value={buyer}
                errors={errors}
                onChange={(next) => {
                  setBuyer(next);
                  setServerErrors({});
                }}
                onBlur={() => setTouched(true)}
              />
            ) : (
              <ContactSummary value={buyer} onEdit={() => setEditing(true)} />
            )}

            <section aria-labelledby="payment-title" className={editing ? "mt-12" : "mt-8"}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h2 id="payment-title" className="display text-[1.9rem]">
                  Payment
                </h2>
                <p className="text-[0.92rem] text-muted">Confirmed before anything ships.</p>
              </div>

              <PaymentOptions
                method={method}
                onMethod={(m) => {
                  setMethod(m);
                  setNotice(null);
                }}
                mode={mode}
                onMode={setMode}
                kind={kind}
                total={total}
                aprBps={aprBps}
                hasWallet={hasWallet}
                coarsePointer={coarsePointer}
                payInFourPaused={payInFourPaused}
                walletPanel={
                  needsSwitch ? (
                    <div className="mt-5 rounded-xl bg-sand px-4 py-4" role="group" aria-label="Switch network">
                      <p className="text-[0.94rem] text-ink">Your wallet is on another network. Polaris takes payments on Monad Testnet.</p>
                      <button type="button" onClick={switchNetwork} disabled={switching} aria-busy={switching || undefined} className="btn btn-line mt-3 bg-paper">
                        {switching ? <Spinner size={16} /> : null}
                        Switch to Monad Testnet
                      </button>
                      {walletError ? (
                        <p role="alert" className="mt-3 text-[0.9rem] text-alert">
                          {walletError}
                        </p>
                      ) : null}
                    </div>
                  ) : walletState !== "idle" || walletError ? (
                    <WalletSteps phase={walletState} error={walletError} lastStep={walletStep} />
                  ) : null
                }
              />

              {errors.payment ? (
                <p className="mt-4 text-[0.92rem] text-alert" role="alert">
                  {errors.payment}
                </p>
              ) : null}

              <div className="mt-6">
                {!polarisConfig.ok ? (
                  <div className="rounded-xl bg-alert-soft p-4 text-[0.95rem] text-alert" role="alert">
                    <p className="font-medium">Payments aren&rsquo;t configured</p>
                    <p className="mt-1">
                      This store isn&rsquo;t connected to Polaris yet, so it can&rsquo;t take an order. Nothing has been charged.
                    </p>
                    {process.env.NODE_ENV === "development" ? <p className="mt-2 font-mono text-[0.82rem]">{polarisConfig.reason}</p> : null}
                  </div>
                ) : method === "polaris" ? (
                  <div onClickCapture={onPolarisClickCapture}>
                    <PolarisCheckoutButton
                      polaris={polaris ?? undefined}
                      createSession={createSession}
                      disabled={!polaris}
                      installments={false}
                      label={polarisLabel}
                      size="lg"
                      onResult={onCheckoutResult}
                      onError={onCheckoutError}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={walletBusy || needsSwitch ? undefined : payFromWallet}
                    disabled={!polaris || noWallet}
                    aria-disabled={walletBusy || needsSwitch || undefined}
                    aria-busy={walletBusy || undefined}
                    className="btn btn-ink h-[3.75rem] w-full text-[1rem]"
                  >
                    {walletBusy ? <Spinner size={18} /> : walletState === "paid" ? <CheckIcon size={18} /> : <WalletIcon size={20} />}
                    {noWallet ? "No wallet in this browser" : (WALLET_LABEL[walletState] ?? `Pay ${formatUsd(total)} from your wallet`)}
                  </button>
                )}
                {!valid && touched ? (
                  <p className="mt-3 text-[0.9rem] text-alert" role="alert">
                    Check your {listFields(Object.keys(clientErrors))}.
                  </p>
                ) : null}
              </div>

              <div id={notice?.at === "top" ? undefined : "checkout-notice"} aria-live="polite">
                {notice && notice.at === "inline" ? (
                  <p
                    className={`mt-5 flex gap-3 rounded-xl p-4 text-[0.95rem] ${notice.tone === "error" ? "bg-alert-soft text-alert" : "bg-sand text-ink-2"}`}
                  >
                    {notice.working ? <Spinner size={18} className="mt-0.5 shrink-0" /> : <AlertIcon size={20} className="mt-0.5 shrink-0" />}
                    {notice.text}
                  </p>
                ) : null}
              </div>
            </section>
          </form>
        </div>

        <aside aria-label="Order summary" className="hidden lg:col-span-5 lg:block">
          <div className="lg:sticky lg:top-24">
            <OrderSummary lines={lines} subtotal={subtotal} shipping={shipping} total={total} mode={method === "polaris" ? mode : null} aprBps={aprBps} />
          </div>
        </aside>
      </div>
    </div>
  );
}
