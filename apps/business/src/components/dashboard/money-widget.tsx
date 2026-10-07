"use client";

import {
  BalanceSummaryCard,
  Button,
  Chip,
  CopyButton,
  DeltaChip,
  DetailsList,
  Dialog,
  DollarCoin,
  IconSquareButton,
  Input,
  KeyValueGrid,
  Money,
  Notice,
  PolarisCoin,
  PrimaryButton,
  SecondaryButton,
  Skeleton,
  StatusPill,
  SwapCard,
  SwapStack,
  SwapToggle,
  TextTabs,
  cn,
} from "@polaris/ui";
import { ArrowUpFromLine, ArrowUpRight, Check, Info, Link2, QrCode as QrIcon, RefreshCw, Settings, WalletCards } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type ReactNode } from "react";
import { getAddress, isAddress, zeroAddress } from "viem";

import { PayoutStatusBadge } from "@/components/dashboard/bits";
import { BalanceUnknown } from "@/components/dashboard/common";
import { QrCode } from "@/components/qr";
import { DataError, errorMessage } from "@/lib/data";
import { MODE_LABEL, money, parseAmount, payInFourQuote, shortAddress } from "@/lib/data/format";
import type { Address as Hex, PayMode, Payment, PaymentLink, Payout, PayoutsState } from "@/lib/data/types";
import { useMerchant } from "@/lib/merchant-context";
import { useWithdraw } from "@/lib/payouts";
import { useDashboardData, useQuery, useReadiness, type QueryState } from "@/lib/session";

/** Polaris's fee on Pay now and each subscription charge; Pay in 4 costs the merchant nothing. */
const FEE_BPS = 50;

/**
 * Check a destination the way the server does: 0x and 40 hex characters; a
 * mixed-case address must match its checksum (a typo protection we keep);
 * all-lowercase or all-uppercase is fine.
 */
export function checkAddress(raw: string, own: string | null): { address: Hex } | { error: string } {
  const v = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return { error: "Enter an address: 0x followed by 40 letters and numbers." };
  const body = v.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && !isAddress(v, { strict: true })) return { error: "Check the address: its capitalisation doesn't match its checksum." };
  const address = getAddress(v.toLowerCase());
  if (address === zeroAddress) return { error: "The zero address can't receive money." };
  if (own && address === getAddress(own)) return { error: "That's your payout account itself. Enter where the money should go." };
  return { address };
}

/** "1,250.00" for the cards' figures (the dollar sign is the coin). */
function figure(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The balance's change over the last 24 hours, in cents: what came in, less
 * what went out. In dollars rather than percent, which reads oddly on a
 * balance that is paid out often ("+114.62%").
 */
function balanceChange(payments: Payment[] | undefined, history: Payout[], now = Date.now()): number | null {
  if (!payments) return null;
  const since = now - 86_400_000;
  const inflow = payments.filter((p) => p.status === "succeeded" && Date.parse(p.createdAt) >= since).reduce((s, p) => s + p.netCents, 0);
  const outflow = history.filter((p) => p.status !== "failed" && Date.parse(p.createdAt) >= since).reduce((s, p) => s + p.amountCents, 0);
  const change = inflow - outflow;
  return change === 0 ? null : change;
}

/** "0x5e61 42e0 3BD4 …": an address in groups of four, easy to check against another copy. */
export function groupedAddress(address: string): string {
  const body = address.slice(6).match(/.{1,4}/g) ?? [];
  return [address.slice(0, 6), ...body].join(" ");
}

export type MoneyTab = "withdraw" | "request";

export type MoneyWidgetProps = {
  defaultTab?: MoneyTab;
  /** The payments list, when the page has it (for the balance's 24-hour change). */
  payments?: Payment[];
  /** A shared payouts query, when the page already loads one. */
  payouts?: QueryState<PayoutsState>;
  /** After a link is created from Request. */
  onLinkCreated?: (link: PaymentLink) => void;
  /** Where the settings square goes. */
  settingsHref?: string;
  /** Replaces REQUEST's dark button ("All payment links"), e.g. on the Links page itself. */
  requestSecondary?: ReactNode;
  className?: string;
};

/**
 * Ref E's trade widget, mapped to Polaris money: WITHDRAW sends your AUSD
 * balance to an address (the two stacked cards, the swap button, "Withdraw",
 * "Change payout address" and the outlined balance card); REQUEST creates a
 * payment link (amount and description over the ways a buyer can pay).
 */
export function MoneyWidget({
  defaultTab = "withdraw",
  payments,
  payouts: shared,
  onLinkCreated,
  settingsHref = "/dashboard/payouts#automatic",
  requestSecondary,
  className,
}: MoneyWidgetProps) {
  const [tab, setTab] = useState<MoneyTab>(defaultTab);
  const own = useQuery((d) => d.getPayouts(), { refreshMs: shared ? undefined : 30_000 });
  const payouts = shared ?? own;
  const { merchant } = useMerchant();
  const router = useRouter();
  const [qr, setQr] = useState(false);
  const id = useId();
  const wallet = payouts.data?.walletAddress ?? merchant.walletAddress;

  return (
    <section aria-label="Move money" className={cn("grid min-w-0 content-start gap-3", className)}>
      <div className="mb-2 flex min-h-10 items-center justify-between gap-3">
        <TextTabs
          size="auto"
          aria-label="Move money"
          options={[
            { value: "withdraw", label: "Withdraw" },
            { value: "request", label: "Request" },
          ]}
          value={tab}
          onValueChange={setTab}
          tabId={(v) => `${id}-tab-${v}`}
          panelId={(v) => `${id}-panel-${v}`}
        />
        <div className="flex gap-2">
          <IconSquareButton
            label="Refresh the balance"
            icon={<RefreshCw className={payouts.refreshing ? "animate-spin motion-reduce:animate-none" : undefined} />}
            onClick={payouts.reload}
          />
          <IconSquareButton label="Show your payout wallet's QR code" icon={<QrIcon />} onClick={() => setQr(true)} disabled={!wallet} />
          <IconSquareButton label="Payout settings" icon={<Settings />} onClick={() => router.push(settingsHref)} />
        </div>
      </div>

      <div role="tabpanel" id={`${id}-panel-withdraw`} aria-labelledby={`${id}-tab-withdraw`} hidden={tab !== "withdraw"} className="grid min-w-0 gap-3">
        {tab === "withdraw" ? <WithdrawPanel payouts={payouts} payments={payments} onSwitch={() => setTab("request")} /> : null}
      </div>
      <div role="tabpanel" id={`${id}-panel-request`} aria-labelledby={`${id}-tab-request`} hidden={tab !== "request"} className="grid min-w-0 gap-3">
        {tab === "request" ? <RequestPanel onCreated={onLinkCreated} onSwitch={() => setTab("withdraw")} secondary={requestSecondary} /> : null}
      </div>

      <Dialog open={qr} onOpenChange={setQr} size="sm" title="Your payout wallet" description="Send AUSD on Monad to this address to top up your balance.">
        <Dialog.Body className="grid justify-items-center gap-5">
          {wallet ? (
            <>
              <QrCode value={wallet} label="QR code of your payout wallet address" size={200} />
              <div className="flex w-full min-w-0 items-center gap-2 rounded-ui-field bg-ui-surface-2 p-1.5 pl-4">
                <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{wallet}</code>
                <CopyButton value={wallet} label="payout address" variant="button" buttonVariant="lime" />
              </div>
            </>
          ) : null}
        </Dialog.Body>
      </Dialog>
    </section>
  );
}

/* ── WITHDRAW ───────────────────────────────────────────────────────────── */

function WithdrawPanel({ payouts, payments, onSwitch }: { payouts: QueryState<PayoutsState>; payments?: Payment[]; onSwitch: () => void }) {
  const { merchant } = useMerchant();
  const blocker = useReadiness().withdraw;
  const withdraw = useWithdraw();
  const state = payouts.data;
  const wallet = state?.walletAddress ?? merchant.walletAddress;
  const balance = state?.balanceCents ?? 0;

  // The amount starts at the whole balance until it is edited.
  const [typed, setTyped] = useState<string | null>(null);
  const amount = typed ?? (state ? figure(balance) : "");
  // The destination: the one you set here, else automatic payouts' address, else the last one used.
  const [chosen, setChosen] = useState<Hex | null>(null);
  const destination = chosen ?? state?.auto.payoutAddress ?? state?.history[0]?.destination ?? null;

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<{ cents: number; to: Hex } | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Payout | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const cents = parseAmount(amount);
  const over = cents !== null && cents > balance;
  // The chain's own change when the server has it (it agrees with the balance to the cent); else the lists'.
  const change = useMemo(
    () => (state ? (state.changeTodayCents !== undefined ? state.changeTodayCents : balanceChange(payments, state.history)) : null),
    [state, payments],
  );
  const ready = !blocker && Boolean(wallet) && state !== undefined;
  // A control that can't work yet is disabled, with its reason under it.
  const empty = state !== undefined && balance === 0;
  const withdrawnBefore = state?.history.some((p) => p.status !== "failed") ?? false;
  const reason =
    blocker ??
    (empty
      ? withdrawnBefore
        ? "All withdrawn. New payments land here in under a second."
        : "Nothing to withdraw yet. Your first payment lands here in under a second."
      : null);

  const toReview = () => {
    if (cents === null) return setError("Enter an amount, like 250 or 99.50.");
    if (over) return setError(`You can withdraw up to ${money(balance)}.`);
    if (!destination) {
      setError("Choose where the money goes first.");
      setEditing(true);
      return;
    }
    const checked = checkAddress(destination, wallet);
    if ("error" in checked) return setError(checked.error);
    setError(null);
    setFailure(null);
    setReview({ cents, to: checked.address });
  };

  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    setFailure(null);
    try {
      const payout = await withdraw(review.cents, review.to);
      setReceipt(payout);
      setReview(null);
      setTyped(null);
      payouts.reload();
    } catch (err) {
      setFailure(err instanceof DataError ? err.message : errorMessage(err, "The withdrawal didn't go through. Nothing was sent."));
    } finally {
      setBusy(false);
    }
  };

  if (payouts.error && !state) {
    return (
      <Notice tone="down" title="We couldn't load your balance" action={<Button variant="outline" size="sm" onClick={payouts.reload}>Retry</Button>}>
        {payouts.error}
      </Notice>
    );
  }
  if (state && state.balanceCents === null) {
    // The chain read failed: no figure, nothing to withdraw against.
    return <BalanceUnknown onRetry={payouts.reload} retrying={payouts.refreshing} />;
  }
  if (!state) {
    return (
      <>
        <Skeleton shape="card" height={172} />
        <Skeleton shape="card" height={172} />
        <Skeleton shape="pill" height={50} />
      </>
    );
  }

  return (
    <>
      <SwapStack
        top={
          <SwapCard
            coin={<PolarisCoin size={42} />}
            symbol="AUSD"
            caption="You send"
            value={amount}
            onValueChange={(v) => {
              setTyped(v);
              setError(null);
            }}
            inputLabel="Amount to withdraw, in dollars"
            invalid={over || (typed !== null && typed.trim() !== "" && cents === null)}
            inputProps={{ disabled: !ready || empty, "aria-describedby": error ? "withdraw-error" : undefined }}
            metaLabel="Balance"
            meta={
              <button
                type="button"
                onClick={() => setTyped(figure(balance))}
                disabled={!ready || balance === 0}
                title="Withdraw the whole balance"
                className="rounded-[6px] underline-offset-4 hover:underline disabled:no-underline"
              >
                {figure(balance)}
              </button>
            }
          />
        }
        toggle={<SwapToggle label="Switch to Request: take a payment instead" onClick={onSwitch} />}
        bottom={
          <SwapCard
            coin={<DollarCoin size={42} />}
            symbol="USD"
            caption="Arrives"
            amount={cents !== null && !over ? figure(cents) : "0.00"}
            metaLabel="To"
            meta={destination ? <span title={destination}>{shortAddress(destination, 6, 4)}</span> : "Not set"}
          />
        }
      />
      {error ? (
        <p id="withdraw-error" role="alert" className="px-1 text-[14px] text-ui-down">
          {error}
        </p>
      ) : null}
      {destination ? (
        <>
          <PrimaryButton
            size="lg"
            block
            className="mt-1"
            icon={<ArrowUpFromLine />}
            disabled={!ready || empty}
            onClick={toReview}
            aria-describedby={reason ? "withdraw-blocked" : undefined}
          >
            {cents !== null && cents > 0 && !over ? `Withdraw ${money(cents)}` : "Withdraw"}
          </PrimaryButton>
          <SecondaryButton size="lg" block iconRight={<WalletCards />} onClick={() => setEditing(true)} disabled={!wallet}>
            Change payout address
          </SecondaryButton>
        </>
      ) : (
        <>
          {/* No address yet: choosing one is the next step, so it takes the lime button. */}
          <PrimaryButton
            size="lg"
            block
            className="mt-1"
            icon={<WalletCards />}
            onClick={() => setEditing(true)}
            disabled={!wallet || !ready}
            aria-describedby={reason ? "withdraw-blocked" : undefined}
          >
            Choose a payout address
          </PrimaryButton>
          <SecondaryButton size="lg" block iconRight={<Link2 />} onClick={onSwitch}>
            Request a payment
          </SecondaryButton>
        </>
      )}
      {reason ? (
        <p id="withdraw-blocked" className="flex gap-2 px-1 text-[13px] leading-snug text-ui-muted">
          <Info aria-hidden size={15} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          {reason}
        </p>
      ) : null}
      <BalanceSummaryCard
        label="Available balance"
        value={<Money value={balance / 100} />}
        badge={
          change === null ? undefined : (
            <DeltaChip value={change} variant="strong" label={`${change > 0 ? "+" : "−"}${money(Math.abs(change))} today`} title="Change in the last 24 hours" />
          )
        }
        stats={[
          { label: "Network fee", value: "$0.00" },
          { label: "You receive", value: money(cents !== null && !over ? cents : 0) },
          { label: "Settles in", value: "0.8 s" },
        ]}
      />

      <AddressDialog
        open={editing}
        onOpenChange={setEditing}
        current={destination}
        wallet={wallet}
        onSave={(a) => {
          setChosen(a);
          setError(null);
        }}
      />

      <Dialog
        open={review !== null || receipt !== null}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setReview(null);
            setReceipt(null);
          }
        }}
        size="sm"
        dismissible={!busy}
        title={receipt ? (receipt.status === "paid" ? "Withdrawal sent" : receipt.status === "failed" ? "Withdrawal failed" : "Withdrawal queued") : "Confirm withdrawal"}
        description={receipt ? receipt.id : "Check the amount and the address. Payouts can't be reversed."}
      >
        <Dialog.Body className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {receipt ? (
            <>
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-full bg-ui-lime text-ui-on-lime">
                  <Check size={18} strokeWidth={2.5} aria-hidden />
                </span>
                <Money value={receipt.amountCents / 100} className="text-[32px] font-semibold tracking-[-0.03em]" />
              </div>
              <DetailsList
                size="sm"
                items={[
                  { label: "Status", value: <PayoutStatusBadge status={receipt.status} /> },
                  { label: "To", value: shortAddress(receipt.destination) },
                  { label: "Network fee", value: "$0.00" },
                ]}
              />
              <p className="text-[14px] leading-relaxed text-ui-muted">
                {receipt.status === "queued"
                  ? "Your signed withdrawal is queued for the relayer. It shows as Paid, with its transaction, once it's on chain."
                  : receipt.status === "paid"
                    ? "Sent. The transaction is in your payout history."
                    : "It didn't go through. Nothing was sent."}
              </p>
            </>
          ) : review ? (
            <>
              <KeyValueGrid
                items={[
                  { label: "Amount", value: money(review.cents) },
                  { label: "Network fee", value: "$0.00" },
                ]}
              />
              <div className="rounded-ui-tile bg-ui-surface-2 px-5 py-4">
                <p className="text-[13px] text-ui-muted">To</p>
                <p className="mt-1 max-w-[26ch] font-mono text-[15px] leading-relaxed text-balance" title={review.to} aria-label={review.to}>
                  {groupedAddress(review.to)}
                </p>
              </div>
              {failure ? (
                <Notice tone="down" size="sm" role="alert">
                  {failure}
                </Notice>
              ) : null}
            </>
          ) : null}
        </Dialog.Body>
        <Dialog.Footer>
          {receipt ? (
            <PrimaryButton onClick={() => setReceipt(null)}>Done</PrimaryButton>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setReview(null)} disabled={busy}>
                Back
              </Button>
              <PrimaryButton loading={busy} onClick={confirm} icon={<ArrowUpFromLine />}>
                Confirm and withdraw
              </PrimaryButton>
            </>
          )}
        </Dialog.Footer>
      </Dialog>
    </>
  );
}

function AddressDialog({
  open,
  onOpenChange,
  current,
  wallet,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: Hex | null;
  wallet: string | null;
  onSave: (a: Hex) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(open);
  if (open !== seen) {
    setSeen(open);
    if (open) {
      setValue(current ?? "");
      setError(null);
    }
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const checked = checkAddress(value, wallet);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    onSave(checked.address);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title="Payout address" description="Where this withdrawal goes: an exchange deposit address, a treasury, a bank on-ramp.">
      <form onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
        <Dialog.Body className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <Input
            label="To"
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            error={error ?? undefined}
            className="font-mono text-[14px]"
          />
          <p className="text-[13px] leading-relaxed text-ui-muted">
            Only for this withdrawal. Automatic daily payouts keep their own address, set on the Payouts page.
          </p>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <PrimaryButton type="submit">Use this address</PrimaryButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

/* ── REQUEST ────────────────────────────────────────────────────────────── */

const WAYS: { mode: PayMode; label: string }[] = [
  { mode: "now", label: "Now" },
  { mode: "later", label: "In 4" },
  { mode: "subscribe", label: "Monthly" },
];

function RequestPanel({ onCreated, onSwitch, secondary }: { onCreated?: (link: PaymentLink) => void; onSwitch: () => void; secondary?: ReactNode }) {
  const data = useDashboardData();
  const blocker = useReadiness().links;
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [modes, setModes] = useState<PayMode[]>(["now", "later"]);
  const [errors, setErrors] = useState<{ amount?: string; description?: string; modes?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<PaymentLink | null>(null);

  const cents = parseAmount(amount);
  const quote = cents && cents >= 20_00 && modes.includes("later") ? payInFourQuote(cents) : null;
  const fee = cents ? Math.round((cents * FEE_BPS) / 10_000) : 0;
  const toggle = (m: PayMode) => {
    setModes((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
    setErrors((e) => ({ ...e, modes: undefined }));
  };

  const create = async () => {
    const next: typeof errors = {};
    if (cents === null) next.amount = "Enter an amount, like 200 or 49.50.";
    if (!description.trim()) next.description = "Say what the buyer is paying for.";
    if (!modes.length) next.modes = "Choose at least one way to pay.";
    if (modes.includes("later") && cents !== null && cents < 20_00) next.modes = "Pay in 4 needs at least $20.00.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const created = await data.createLink({ description: description.trim(), amountCents: cents!, modes, usage: "reusable", expiresInHours: null });
      // The Link ready card takes the cards' place and confirms it: no toast.
      setLink(created);
      onCreated?.(created);
    } catch (err) {
      const field = err instanceof DataError ? err.field : undefined;
      const message = errorMessage(err);
      setErrors(
        field === "amountCents" ? { amount: message } : field === "description" ? { description: message } : field === "modes" ? { modes: message } : { form: message },
      );
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setLink(null);
    setAmount("");
    setDescription("");
    setModes(["now", "later"]);
  };

  const errorText = errors.amount ?? errors.description ?? errors.modes ?? errors.form;

  return (
    <>
      {/* The Link ready card takes the two cards' cell: the cards stay laid
          out (hidden and inert) so the cell keeps their height and nothing
          under it moves. */}
      <div className="grid min-w-0 [&>*]:col-start-1 [&>*]:row-start-1">
        <div className={cn("min-w-0", link && "invisible")} inert={link ? true : undefined}>
          <SwapStack
            top={
              <SwapCard coin={<DollarCoin size={42} />} symbol="USD" caption="You request">
                <input
                  aria-label="Amount to request, in dollars"
                  aria-invalid={Boolean(errors.amount) || undefined}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setErrors((x) => ({ ...x, amount: undefined }));
                  }}
                  className={cn(
                    "ui-figure w-full bg-transparent font-satoshi text-[34px] leading-none font-medium tracking-[-0.03em] outline-none placeholder:text-ui-dim sm:text-[40px]",
                    "rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus",
                    errors.amount ? "text-ui-down" : "text-ui-text",
                  )}
                />
                <input
                  aria-label="What it's for"
                  aria-invalid={Boolean(errors.description) || undefined}
                  placeholder="What it's for: Brand identity package"
                  maxLength={120}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setErrors((x) => ({ ...x, description: undefined }));
                  }}
                  className="mt-3 w-full rounded-[8px] bg-transparent text-[15px] text-ui-text outline-none placeholder:text-ui-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus"
                />
              </SwapCard>
            }
            toggle={<SwapToggle label="Switch to Withdraw: send your balance out" onClick={onSwitch} />}
            bottom={
              <SwapCard coin={<PolarisCoin size={42} />} symbol="Buyer can pay" caption="Ways">
                <div role="group" aria-label="Ways the buyer can pay" className="flex flex-wrap gap-2">
                  {WAYS.map((w) => (
                    <Chip key={w.mode} variant="pill" selected={modes.includes(w.mode)} onClick={() => toggle(w.mode)} title={MODE_LABEL[w.mode]}>
                      {w.label}
                    </Chip>
                  ))}
                </div>
                <p className="ui-figure mt-3 text-[14px] text-ui-muted">
                  {quote ? `In 4: 4 × ${money(quote.each)} at 10% APR, paid by the buyer` : modes.includes("later") ? "Pay in 4 from $20.00" : "Paid in full, in dollars"}
                </p>
              </SwapCard>
            }
          />
        </div>
        {link ? <LinkReady link={link} blocker={blocker} /> : null}
      </div>
      {errorText ? (
        <p role="alert" className="px-1 text-[14px] text-ui-down">
          {errorText}
        </p>
      ) : null}
      {link ? (
        <PrimaryButton size="lg" block className="mt-1" icon={<Link2 />} onClick={reset}>
          Create another link
        </PrimaryButton>
      ) : (
        <PrimaryButton size="lg" block className="mt-1" icon={<Link2 />} loading={busy} onClick={() => void create()}>
          Create link
        </PrimaryButton>
      )}
      {secondary ?? (
        <SecondaryButton asChild size="lg" block iconRight={<ArrowUpRight />}>
          <Link href="/dashboard/links">All payment links</Link>
        </SecondaryButton>
      )}
      {link ? null : (
        <BalanceSummaryCard
          label="You receive"
          value={<Money value={(cents ? cents - (modes.length === 1 && modes[0] === "later" ? 0 : fee) : 0) / 100} />}
          badge={
            <StatusPill tone="lime" size="sm">
              {modes.includes("later") ? "100% up front" : "In 0.8 s"}
            </StatusPill>
          }
          stats={[
            { label: "Fee", value: modes.length === 1 && modes[0] === "later" ? "$0.00" : "0.5%" },
            { label: "Pay in 4", value: quote ? `4 × ${money(quote.each)}` : "—" },
            { label: "Settles in", value: "0.8 s" },
          ]}
        />
      )}
    </>
  );
}

/**
 * The new link, in the two cards' place and about their height, so the
 * buttons under it stay put: the QR code, what it's for, the amount, and
 * the link with Copy and Open.
 */
function LinkReady({ link, blocker }: { link: PaymentLink; blocker: string | null }) {
  return (
    <div className="flex h-full min-w-0 flex-col rounded-ui-panel bg-ui-surface-1 p-5" aria-live="polite">
      <p className="flex items-center gap-2 text-[14px] text-ui-muted">
        <Check aria-hidden size={16} strokeWidth={2.25} className="text-ui-lime-text" />
        Link ready
      </p>
      <div className="mt-4 flex min-w-0 flex-1 items-center gap-5">
        {blocker ? null : (
          <span className="shrink-0 overflow-hidden rounded-[16px]">
            <QrCode value={link.url} label={`QR code for ${link.description}`} size={132} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[18px] leading-snug font-medium">{link.description}</p>
          <Money value={link.amountCents / 100} className="mt-1.5 block text-[30px] leading-none font-medium tracking-[-0.03em]" />
          <p className="mt-2 text-[13px] text-ui-muted">{link.modes.map((m) => MODE_LABEL[m]).join(" · ")}</p>
        </div>
      </div>
      {blocker ? (
        <p className="mt-4 text-[13px] leading-snug text-ui-muted">{blocker} Sharing and the QR code switch on then.</p>
      ) : (
        <div className="mt-4 grid min-w-0 gap-2">
          <code className="block min-w-0 truncate rounded-ui-field bg-ui-canvas px-3.5 py-2.5 font-mono text-[12.5px] text-ui-muted" title={link.url}>
            {link.url}
          </code>
          <div className="grid grid-cols-2 gap-2">
            <Button asChild variant="outline" size="sm" icon={<ArrowUpRight />} className="w-full">
              <a href={link.url} target="_blank" rel="noreferrer">
                Open
              </a>
            </Button>
            <CopyButton value={link.url} label="link" variant="button" buttonVariant="lime" size="sm" className="w-full" />
          </div>
        </div>
      )}
    </div>
  );
}
