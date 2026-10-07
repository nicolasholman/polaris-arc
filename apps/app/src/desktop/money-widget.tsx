"use client";

import {
  BalanceSummaryCard,
  Coin,
  CopyButton,
  cn,
  DeltaChip,
  Dialog,
  DollarCoin,
  IconDisc,
  IconSquareButton,
  ListGroup,
  ListRow,
  Money,
  PrimaryButton,
  SecondaryButton,
  Sheet,
  Skeleton,
  SwapCard,
  SwapStack,
  SwapToggle,
  TextTabs,
} from "@polaris/ui";
import { ArrowDownLeft, ArrowUpRight, Check, Link2, Plus, RefreshCw, ScanFace, ScanLine, Settings, Share2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { getAddress, isAddress } from "viem";
import { PersonAvatar } from "@/components/avatars";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { QrCode } from "@/components/qr";
import { useCloseSheet } from "@/components/shell/sheet-host";
import { SuccessSheet } from "@/components/success-sheet";
import { type CreatedSendLink, createSendLink, transferTo } from "@/lib/actions";
import { useAccountState, useOwner } from "@/lib/account/hooks";
import { useOrigin } from "@/lib/browser";
import { receiveLink } from "@/lib/links";
import { getActivity, getBalance, getContacts, getCreditLine, getPlans, getProfile, type Person } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { shortDate } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { type Micros, parseAmount, toNumber, usd } from "@/lib/money";
import { setPrefs, usePrefs } from "@/lib/prefs";
import type { RelayReceipt } from "@/lib/relayer";
import { creditFreed } from "@/lib/series";
import { useNow } from "@/lib/use-now";
import { n } from "@/lib/view";
import { firstName, LinkReady, type Recipient } from "@/sheets/send";
import { SenderNameField } from "@/components/sender-name";

export type MoneyTab = "send" | "receive";

type Result = { kind: "link"; link: CreatedSendLink; recipient: Recipient } | { kind: "sent"; receipt: RelayReceipt; amount: Micros; to: Person };

/** "1,284.50": the cards' figures (the dollar sign is the coin). */
function figure(micros: Micros): string {
  return toNumber(micros).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Digits and one point, at most two decimals: what the amount field accepts. */
function cleanAmount(raw: string): string {
  const s = raw.replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = s.split(".");
  if (!rest.length) return whole.slice(0, 9);
  return `${whole.slice(0, 9)}.${rest.join("").slice(0, 2)}`;
}

/** The lime link coin: a link is who gets it, until someone opens it. */
function LinkCoin({ size = 42 }: { size?: number }) {
  return (
    <Coin tone="lime" size={size}>
      <Link2 aria-hidden size={Math.round(size * 0.46)} strokeWidth={2.25} />
    </Coin>
  );
}

/**
 * Ref E's trade widget, mapped to the buyer: SEND is the two stacked cards
 * (your dollars over what they get, by link or straight to someone), the lime
 * Send, "Pay a link" and "Split a bill", and your credit in the outlined card; RECEIVE
 * is your code, your link and Add money.
 */
export function MoneyWidget({ defaultTab = "send", className }: { defaultTab?: MoneyTab; className?: string }) {
  const router = useRouter();
  const owner = useOwner();
  const balance = useData(() => getBalance(owner), [owner]);
  const [tab, setTab] = useState<MoneyTab>(defaultTab);
  const [spinning, setSpinning] = useState(false);
  const id = useId();

  const refresh = () => {
    setSpinning(true);
    balance.reload();
    window.setTimeout(() => setSpinning(false), 700);
  };

  return (
    <section aria-label="Move money" className={cn("grid min-w-0 content-start gap-3", className)}>
      <div className="mb-2 flex min-h-10 items-center justify-between gap-3">
        <TextTabs
          aria-label="Move money"
          options={[
            { value: "send", label: "Send" },
            { value: "receive", label: "Receive" },
          ]}
          value={tab}
          onValueChange={setTab}
          tabId={(v) => `${id}-tab-${v}`}
          panelId={(v) => `${id}-panel-${v}`}
        />
        <div className="flex gap-2">
          <IconSquareButton
            label="Refresh your balance"
            icon={<RefreshCw className={spinning ? "animate-spin motion-reduce:animate-none" : undefined} />}
            onClick={refresh}
          />
          <IconSquareButton label="Pay or claim a Polaris link" icon={<ScanLine />} onClick={() => router.push("/pay", { scroll: false })} />
          <IconSquareButton label="Settings" icon={<Settings />} onClick={() => router.push("/settings")} />
        </div>
      </div>

      <div role="tabpanel" id={`${id}-panel-send`} aria-labelledby={`${id}-tab-send`} hidden={tab !== "send"} className="grid min-w-0 gap-3">
        {tab === "send" ? (
          <>
            <SendForm />
            <CreditSummary className="mt-1" />
          </>
        ) : null}
      </div>
      <div role="tabpanel" id={`${id}-panel-receive`} aria-labelledby={`${id}-tab-receive`} hidden={tab !== "receive"} className="grid min-w-0 gap-3">
        {tab === "receive" ? <ReceivePanel /> : null}
      </div>
    </section>
  );
}

/* ── SEND ───────────────────────────────────────────────────────────────── */

/** /send from 1024px: the widget's SEND in a Dialog, who from the URL (a Receive code or a contact). */
export function SendDialogContent() {
  const params = useSearchParams();
  const owner = useOwner();
  const contacts = useData(() => getContacts(owner), [owner]);
  const close = useCloseSheet();
  const initial = useRecipientFromUrl(params, contacts.value);
  return (
    <Sheet.Body className="grid content-start gap-3 pt-1">
      <SendForm initial={initial} onDone={close} showPay={false} />
    </Sheet.Body>
  );
}

/** Who the money is for, from the URL: a Receive code (?to=) or a saved contact (?contact=). */
export function useRecipientFromUrl(params: URLSearchParams | null, contacts: Person[] | undefined): Recipient {
  const to = params?.get("to");
  const contactId = params?.get("contact");
  if (to && isAddress(to)) {
    const name = (params?.get("n") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40).trim();
    return { kind: "account", person: { id: to, name: name || "Polaris account", country: "US", handle: "Polaris account", address: getAddress(to) } };
  }
  if (contactId) {
    const person = contacts?.find((p) => p.id === contactId);
    if (person) return { kind: "contact", person };
  }
  return { kind: "link" };
}

/**
 * The two stacked cards: "USD · You send · 25.00 · Balance 1,284.50" over
 * "Link · They get · 25.00 · Anyone with the link". The round button on the
 * seam changes who gets it. Then Send (Face ID), "Pay a link" and "Split a bill".
 */
export function SendForm({ initial, onDone, showPay = true }: { initial?: Recipient; onDone?: () => void; showPay?: boolean }) {
  const router = useRouter();
  const state = useAccountState();
  const owner = useOwner();
  const balance = useData(() => getBalance(owner), [owner]);
  const contacts = useData(() => getContacts(owner), [owner]);
  const profile = useData(() => getProfile(owner), [owner]);
  const prefs = usePrefs();
  // Empty (the 0.00 placeholder) until the buyer types: nothing is "more than your balance" before they do.
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState<Recipient | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // Asked once, in the confirm of the first link: the name the claimer sees.
  const [nameField, setNameField] = useState("");

  useEffect(() => prefetchDomains("ausd", "send"), []);

  const recipient = picked ?? initial ?? { kind: "link" };
  const who = recipient.kind === "link" ? null : recipient.person;
  const amount = parseAmount(value || "0") ?? 0n;
  const available = balance.value?.available;
  const tooMuch = available !== undefined && state.status !== "none" && amount > available;
  // Nothing to send yet: Add money is the way forward.
  const broke = available === 0n && state.status !== "none";
  const senderName = prefs.name || profile.value?.name || "";

  const finish = () => {
    setResult(null);
    setValue("");
    onDone?.();
  };

  // In the Send dialog (desktop /send) the link takes the form's place, rather than a second dialog on top of it.
  if (!showPay && result?.kind === "link") {
    return <LinkReady inline link={result.link} recipient={result.recipient} senderName={senderName} onDone={finish} />;
  }

  return (
    <>
      <SwapStack
        top={
          <SwapCard
            coin={<DollarCoin size={42} />}
            symbol="USD"
            caption="You send"
            value={value}
            onValueChange={(v) => setValue(cleanAmount(v))}
            // "12.5" reads "12.50" once you leave the field, like the card under it.
            inputProps={{ onBlur: () => setValue((v) => (v && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : v)) }}
            inputLabel="Amount to send, in dollars"
            invalid={tooMuch}
            metaLabel="Balance"
            meta={available !== undefined ? figure(available) : "…"}
          />
        }
        bottom={
          <SwapCard
            coin={who ? <PersonAvatar name={who.name} size="sm" className="size-[42px]" /> : <LinkCoin />}
            symbol={who ? firstName(who.name) : "Link"}
            caption="They get"
            amount={figure(amount)}
            metaLabel={who ? "To" : "For"}
            meta={who ? who.handle : "Anyone with the link"}
          />
        }
        toggle={<SwapToggle label="Change who gets it" onClick={() => setPicking(true)} />}
      />
      {tooMuch ? null : <LocalEquivalent amount={amount} className="px-1 text-[14px]" />}
      {tooMuch ? (
        <p role="status" className="px-1 text-[14px] text-ui-down">
          That&apos;s more than your balance.
        </p>
      ) : null}
      {broke ? (
        <>
          <PrimaryButton size="lg" block icon={<Plus />} onClick={() => router.push("/add", { scroll: false })}>
            Add money
          </PrimaryButton>
          <p className="px-1 text-[13px] leading-snug text-ui-muted">Your balance is $0.00. Add money, then send it by link or to someone with Polaris.</p>
        </>
      ) : (
        <PrimaryButton size="lg" block icon={<ArrowUpRight />} disabled={amount === 0n || tooMuch} onClick={() => setConfirming(true)}>
          Send {usd(amount)}
        </PrimaryButton>
      )}
      {showPay ? (
        <div className="grid grid-cols-2 gap-3">
          <SecondaryButton size="lg" block iconRight={<ScanLine />} onClick={() => router.push("/pay", { scroll: false })}>
            Pay a link
          </SecondaryButton>
          <SecondaryButton size="lg" block iconRight={<Users />} onClick={() => router.push("/split/new", { scroll: false })}>
            Split a bill
          </SecondaryButton>
        </div>
      ) : null}

      <Dialog open={picking} onOpenChange={setPicking} size="sm" title="Send to" description="By link, or straight to someone you've paid before.">
        <Dialog.Body>
          <ListGroup>
            <ListRow
              icon={<Link2 />}
              tone="lime"
              title="Anyone with a link"
              description="Share it anywhere; they claim it with Face ID"
              trailing={recipient.kind === "link" ? <Check aria-label="Selected" size={18} className="text-ui-lime-text" /> : undefined}
              chevron={false}
              onClick={() => {
                setPicked({ kind: "link" });
                setPicking(false);
              }}
            />
            {(contacts.value ?? []).map((person) => (
              <ListRow
                key={person.id}
                well={false}
                icon={<PersonAvatar name={person.name} decorative />}
                title={person.name}
                description={person.handle}
                trailing={
                  recipient.kind === "contact" && recipient.person.id === person.id ? (
                    <Check aria-label="Selected" size={18} className="text-ui-lime-text" />
                  ) : undefined
                }
                chevron={false}
                onClick={() => {
                  setPicked({ kind: "contact", person });
                  setPicking(false);
                }}
              />
            ))}
          </ListGroup>
        </Dialog.Body>
      </Dialog>

      <ConfirmSheet
        open={confirming}
        onOpenChange={setConfirming}
        title={`Send ${usd(amount, { trim: true })}`}
        summary={
          <>
            {recipient.kind === "account"
              ? `Straight to ${recipient.person.name}'s account. It lands in under a second.`
              : who
                ? `A link for ${firstName(who.name)}. Whoever opens it gets the dollars, so share it only with them.`
                : "A link anyone can claim with Face ID. Share it only with the person it's for."}
            {recipient.kind !== "account" && !prefs.name ? <SenderNameField value={nameField} onChange={setNameField} /> : null}
          </>
        }
        newLabel="Send with Face ID"
        busyLabel={recipient.kind === "account" ? "Sending…" : "Making your link…"}
        onAccount={async (signer) => {
          if (recipient.kind === "account") {
            const receipt = await transferTo(signer, recipient.person, amount);
            setResult({ kind: "sent", receipt, amount, to: recipient.person });
          } else {
            const typed = nameField.trim();
            if (typed && !prefs.name) setPrefs({ name: typed });
            const link = await createSendLink(signer, amount, typed || senderName || "A friend", window.location.origin);
            setResult({ kind: "link", link, recipient });
          }
        }}
      />

      {result?.kind === "sent" ? (
        <SuccessSheet
          open
          onOpenChange={() => finish()}
          title="Sent."
          subtitle={`${usd(result.amount, { trim: true })} is in ${result.to.name}'s account.`}
          receiptUrl={result.receipt.explorerUrl}
          rows={[
            { label: "To", value: result.to.name },
            { label: "Amount", value: usd(result.amount) },
            { label: "Network fee", value: "None" },
          ]}
          primary={{ label: "Done", onClick: finish }}
        />
      ) : result?.kind === "link" ? (
        <LinkReady link={result.link} recipient={result.recipient} senderName={senderName} onDone={finish} />
      ) : null}
    </>
  );
}

/**
 * The outlined card under the widget: what the Pay later line can spend,
 * what paying back freed this week, the next payment, the plans and the score.
 */
export function CreditSummary({ className }: { className?: string }) {
  const owner = useOwner();
  const credit = useData(() => getCreditLine(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const now = useNow();
  if (!credit.value || !plans.value || !now) return <Skeleton shape="tile" height={150} className={cn("rounded-ui-panel", className)} />;
  const c = credit.value;
  const active = plans.value.plans.filter((p) => p.status === "active").length;
  const freed = creditFreed(plans.value.plans, 7, now);
  return (
    <Link
      href="/credit"
      className={cn(
        "block rounded-ui-panel transition-colors hover:bg-ui-surface-1/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus",
        className,
      )}
      aria-label={`Pay later line: ${usd(c.available)} available to spend. Open Credit`}
    >
      <BalanceSummaryCard
        label="Pay later available"
        value={<Money value={n(c.available)} />}
        badge={
          freed > 0 ? (
            <DeltaChip value={null} label={`+${usd(BigInt(Math.round(freed * 1e6)), { trim: true })} this week`} variant="strong" title="Paid back to your line this week" />
          ) : undefined
        }
        stats={[
          { label: "Next payment", value: c.nextPayment ? `${usd(c.nextPayment.amount)} · ${shortDate(c.nextPayment.dueAt)}` : "None due" },
          { label: "Active plans", value: active },
          { label: "Score", value: c.score },
        ]}
      />
    </Link>
  );
}

/* ── RECEIVE ────────────────────────────────────────────────────────────── */

/** Your code and your link: anyone with Polaris can scan or open it and pay you. */
function ReceivePanel() {
  const router = useRouter();
  const state = useAccountState();
  const owner = useOwner();
  const origin = useOrigin();
  const { name } = usePrefs();
  const profile = useData(() => getProfile(owner), [owner]);
  const activity = useData(() => getActivity(owner), [owner]);
  const now = useNow();
  const address = state.status === "ready" || state.status === "locked" ? state.address : null;
  const shown = name || profile.value?.name || "";
  const link = address && origin ? receiveLink(origin, address, name) : null;
  const url = link?.url ?? null;

  const week = useMemo(() => {
    if (!activity.value || !now) return null;
    const recent = activity.value.filter((a) => a.direction === "in" && now - a.at <= 7 * 86_400_000);
    const sum = (kinds: string[]) => recent.filter((a) => kinds.includes(a.kind)).reduce((s, a) => s + a.amount, 0n);
    return { total: recent.reduce((s, a) => s + a.amount, 0n), people: sum(["received"]), links: sum(["claimed"]), added: sum(["added", "refund"]) };
  }, [activity.value, now]);

  if (!url) {
    return (
      <div className="grid justify-items-center gap-4 rounded-ui-swap bg-ui-surface-1 px-6 py-10 text-center">
        <IconDisc icon={<ScanFace size={30} strokeWidth={1.5} />} />
        <p className="max-w-[30ch] text-[15px] leading-[1.45] text-ui-muted">Your code needs an account first. It takes one Face ID.</p>
        <PrimaryButton size="lg" block onClick={() => router.push("/onboard?next=/")}>
          Create your account
        </PrimaryButton>
      </div>
    );
  }

  const share = () => {
    if (navigator.share) void navigator.share({ title: "Pay me with Polaris", url }).catch(() => undefined);
    else void navigator.clipboard.writeText(url).catch(() => undefined);
  };

  return (
    <>
      <div className="grid justify-items-center gap-4 rounded-ui-swap bg-ui-surface-1 px-5 pt-6 pb-5">
        <QrCode value={url} size={176} label="Your Polaris code for receiving dollars" />
        <p className="max-w-[32ch] text-center text-[15px] leading-[1.45] text-ui-muted">
          {shown ? (
            <>
              <span className="font-medium text-ui-text">{shown}</span>. Anyone with Polaris can scan this and pay you.
            </>
          ) : (
            "Anyone with Polaris can scan this and pay you in seconds."
          )}
        </p>
        <div className="flex w-full min-w-0 items-center gap-2 rounded-ui-field bg-ui-surface-2 p-1.5 pl-4">
          <span className="min-w-0 flex-1 truncate text-[14px]" title="Your receive link">
            {link?.shown}
          </span>
          <CopyButton value={url} label="receive link" />
          <IconSquareButton label="Share your receive link" icon={<Share2 />} tone="solid" size="sm" onClick={share} />
        </div>
      </div>
      <SecondaryButton size="lg" block iconRight={<Plus />} onClick={() => router.push("/add", { scroll: false })}>
        Add money
      </SecondaryButton>
      {week ? (
        <BalanceSummaryCard
          className="mt-1"
          label="Money in this week"
          value={<Money value={n(week.total)} />}
          badge={<DeltaChip value={null} label={<span className="inline-flex items-center gap-1"><ArrowDownLeft aria-hidden size={14} strokeWidth={2} />No fees</span>} variant="strong" />}
          stats={[
            { label: "From people", value: usd(week.people) },
            { label: "Claimed links", value: usd(week.links) },
            { label: "Added", value: usd(week.added) },
          ]}
        />
      ) : (
        <Skeleton shape="tile" height={150} className="mt-1 rounded-ui-panel" />
      )}
    </>
  );
}
