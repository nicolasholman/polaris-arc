"use client";

import {
  AmountDisplay,
  applyKey,
  Avatar,
  BottomSheet,
  Button,
  DetailsList,
  IconButton,
  Keypad,
  ListGroup,
  ListRow,
  MiniCardCarousel,
  ScreenHeader,
  SecondaryButton,
  Sheet,
  Skeleton,
  SuccessCheck,
  toast,
  TxRow,
  useIsDesktop,
} from "@polaris/ui";
import { Check, Copy, History, Link2, RefreshCw, Share2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { getAddress, isAddress } from "viem";
import { useAccounts } from "@/components/accounts";
import { PersonAvatar } from "@/components/avatars";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { QrCode } from "@/components/qr";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { SuccessSheet } from "@/components/success-sheet";
import { SendDialogContent } from "@/desktop/money-widget";
import { cancelSendLink, type CreatedSendLink, createSendLink, transferTo } from "@/lib/actions";
import { useAccountState, useOwner } from "@/lib/account/hooks";
import { getContacts, getProfile, getSendLink, type Person } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { longDate } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { type Micros, parseAmount, usd } from "@/lib/money";
import type { HomeAccount } from "@/lib/prefs";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { SenderNameField } from "@/components/sender-name";
import type { RelayReceipt } from "@/lib/relayer";

export type Recipient =
  | { kind: "link" }
  | { kind: "contact"; person: Person }
  | { kind: "account"; person: Person & { address: `0x${string}` } };

type Result =
  | { kind: "link"; link: CreatedSendLink; recipient: Recipient }
  | { kind: "sent"; receipt: RelayReceipt; amount: Micros; to: Person };

export function firstName(name: string): string {
  return name.split(" ")[0] ?? name;
}

/** Send, on ref A's transfer screen: who, from which account, how much, Send, the keypad. */
export function SendSheet() {
  const params = useSearchParams();
  const router = useRouter();
  const close = useCloseSheet();
  const state = useAccountState();
  const owner = useOwner();
  const contacts = useData(() => getContacts(owner), [owner]);
  const profile = useData(() => getProfile(owner), [owner]);
  const prefs = usePrefs();
  const { accounts, balance } = useAccounts();

  const [value, setValue] = useState("");
  const [from, setFrom] = useState<HomeAccount>("dollar");
  const [picked, setPicked] = useState<Recipient | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // Asked once, in the confirm of the first link: the name the claimer sees.
  const [nameField, setNameField] = useState("");

  useEffect(() => prefetchDomains("ausd", "send"), []);

  // Who the money is for: a Receive code (?to=), a saved contact (?contact=), or anyone with a link.
  let fromUrl: Recipient = { kind: "link" };
  const to = params.get("to");
  const contactId = params.get("contact");
  if (to && isAddress(to)) {
    const name = (params.get("n") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40).trim();
    fromUrl = {
      kind: "account",
      person: { id: to, name: name || "Polaris account", country: "US", handle: "Polaris account", address: getAddress(to) },
    };
  } else if (contactId) {
    const person = contacts.value?.find((p) => p.id === contactId);
    if (person) fromUrl = { kind: "contact", person };
  }
  const recipient = picked ?? fromUrl;

  const amount = parseAmount(value || "0") ?? 0n;
  const available = balance?.available;
  const tooMuch = available !== undefined && state.status !== "none" && amount > available;
  const wrongAccount = from !== "dollar";
  const senderName = prefs.name || profile.value?.name || "";
  const who = recipient.kind === "link" ? null : recipient.person;

  const hint = wrongAccount
    ? from === "later"
      ? "Pay later works at checkout. Send from your dollar account."
      : "Boost is locked to raise your line. Send from your dollar account."
    : tooMuch
      ? "That's more than your balance"
      : available !== undefined
        ? `Available ${usd(available)}`
        : " ";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Send"
        onBack={close}
        action={<IconButton label="Sent before" icon={<History />} tone="ghost" onClick={() => router.push("/activity")} />}
        className="-mt-2 shrink-0 px-5"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-[max(16px,env(safe-area-inset-bottom))]">
        <TxRow
          static
          variant="card"
          className="min-h-[68px] rounded-ui-tile"
          leading={
            who ? (
              <PersonAvatar name={who.name} />
            ) : (
              <Avatar name="Link" color="var(--ui-lime)" fg="#0f1011" icon={<Link2 />} />
            )
          }
          title={who ? who.name : "Anyone with the link"}
          subtitle={who ? who.handle : "They claim it with Face ID"}
          value={
            <IconButton
              label="Change who you're sending to"
              icon={<RefreshCw />}
              tone="ghost"
              className="-mr-2 text-ui-muted"
              onClick={() => setPicking(true)}
            />
          }
        />

        {accounts.length ? (
          <MiniCardCarousel aria-label="Send from" cards={accounts} value={from} onValueChange={(id) => setFrom(id as HomeAccount)} />
        ) : (
          <div className="flex gap-2 overflow-hidden py-1">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} shape="tile" width={108} height={104} className="shrink-0 rounded-[16px]" />
            ))}
          </div>
        )}

        <div className="flex min-h-[112px] flex-1 items-center justify-center">
          <AmountDisplay
            value={value}
            invalid={tooMuch}
            hint={
              <span className="flex flex-col items-center gap-1.5">
                {tooMuch || wrongAccount ? null : <LocalEquivalent amount={amount} className="text-[13px]" />}
                <span className={tooMuch ? "text-ui-down" : undefined}>{hint}</span>
              </span>
            }
          />
        </div>

        <Button
          variant="lime"
          size="xl"
          block
          disabled={amount === 0n || tooMuch || wrongAccount}
          onClick={() => setConfirming(true)}
        >
          Send
        </Button>
        <Keypad onKey={(k) => setValue((v) => applyKey(v, k))} onClear={() => setValue("")} captureKeyboard={!confirming && !picking} />
      </div>

      <BottomSheet open={picking} onOpenChange={setPicking} snapPoints={["half", "full"]} title="Send to" maxWidth={440}>
        <Sheet.Body className="pt-1">
          <ListGroup>
            <ListRow
              icon={<Link2 />}
              tone="lime"
              title="Anyone with a link"
              description="Share it anywhere; they claim it with Face ID"
              trailing={recipient.kind === "link" ? <Check aria-label="Selected" size={18} className="text-ui-lime" /> : undefined}
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
                    <Check aria-label="Selected" size={18} className="text-ui-lime" />
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
        </Sheet.Body>
      </BottomSheet>

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
          onOpenChange={() => close()}
          title="Sent."
          subtitle={`${usd(result.amount, { trim: true })} is in ${result.to.name}'s account.`}
          receiptUrl={result.receipt.explorerUrl}
          rows={[
            { label: "To", value: result.to.name },
            { label: "Amount", value: usd(result.amount) },
            { label: "Network fee", value: "None" },
          ]}
          primary={{ label: "Done", onClick: close }}
        />
      ) : result?.kind === "link" ? (
        <LinkReady link={result.link} recipient={result.recipient} senderName={senderName} onDone={close} />
      ) : null}
    </div>
  );
}

/** The link is made: share it, watch it get claimed, or take it back. */
export function LinkReady({
  link,
  recipient,
  senderName,
  onDone,
  inline = false,
}: {
  link: CreatedSendLink;
  recipient: Recipient;
  senderName: string;
  onDone: () => void;
  /** Render in the dialog it was made in (the desktop Send), not as a sheet on top of it. */
  inline?: boolean;
}) {
  const status = useData(() => getSendLink(link.linkKey), [link.linkKey]);
  const [cancelling, setCancelling] = useState(false);
  const desktop = useIsDesktop();
  const who = recipient.kind === "contact" ? firstName(recipient.person.name) : null;
  const state = status.value?.status ?? "open";

  async function share() {
    const text = `${usd(link.amount, { trim: true })} from ${senderName || "a friend"}. Open the link to claim it.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Polaris", text, url: link.url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copy();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      toast({ title: "Link copied", tone: "success" });
    } catch {
      toast({ title: "Couldn't copy the link", tone: "error" });
    }
  }

  const title = state === "claimed" ? "Claimed." : state === "cancelled" ? "Cancelled." : "Link ready.";
  const subtitle =
    state === "claimed"
      ? `${usd(link.amount, { trim: true })} arrived${who ? ` with ${who}` : ""}.`
      : state === "cancelled"
        ? "The money is back in your account."
        : (
            <>
              Whoever opens it gets {usd(link.amount, { trim: true })}. Share it only with {who ?? "the person it's for"}.
              <LocalEquivalent amount={link.amount} className="mt-1.5 block text-[13px]" />
            </>
          );
  const rows = [
    { label: "Amount", value: usd(link.amount) },
    { label: "For", value: who ?? "Anyone with the link" },
    { label: state === "open" ? "Claim by" : "Status", value: state === "open" ? longDate(link.expiresAt) : state === "claimed" ? "Claimed" : "Cancelled" },
  ];
  const cancelSheet = (
    <ConfirmSheet
      open={cancelling}
      onOpenChange={setCancelling}
      title="Cancel this link?"
      summary={`${usd(link.amount, { trim: true })} comes back to your account, and the link stops working.`}
      confirmLabel="Cancel link with Face ID"
      busyLabel="Cancelling…"
      danger
      onAccount={async (signer) => {
        await cancelSendLink(signer, link.linkKey);
        status.reload();
      }}
    />
  );

  const actions =
    state === "open" ? (
      <div className="flex flex-col items-center gap-3">
        <QrCode value={link.url} size={132} label="QR code of your send link" />
        <div className="grid w-full grid-cols-2 gap-2">
          {desktop ? (
            // Ref E's dark button from 1024px, a peer of Copy (Done is the one lime); the phone keeps its white.
            <SecondaryButton size="sm" icon={<Share2 />} className="bg-ui-surface-2 hover:bg-ui-surface-3" onClick={() => void share()}>
              Share link
            </SecondaryButton>
          ) : (
            <Button variant="white" size="md" icon={<Share2 />} onClick={() => void share()}>
              Share link
            </Button>
          )}
          <Button variant="dark" size="md" icon={<Copy />} className="lg:bg-ui-surface-2 lg:hover:bg-ui-surface-3" onClick={() => void copy()}>
            Copy
          </Button>
        </div>
        <Button variant="ghost" size="sm" className="text-ui-down" onClick={() => setCancelling(true)}>
          Cancel link
        </Button>
      </div>
    ) : null;

  // From 1024px the link takes the Send form's place in its one Dialog (as a claim's receipt does).
  if (inline) {
    return (
      <>
        <div className="flex flex-col items-center gap-2 pt-2 text-center">
          <SuccessCheck label={title.replace(/\.$/, "")} size={80} />
          <h2 className="mt-3 text-[34px] leading-none font-semibold tracking-[-0.035em]">{title}</h2>
          <p role="status" className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
            {subtitle}
          </p>
          <DetailsList size="sm" items={rows} className="mt-3 w-full text-left" />
          {actions ? <div className="mt-2 w-full">{actions}</div> : null}
        </div>
        <Button variant="lime" size="lg" block onClick={onDone}>
          Done
        </Button>
        {cancelSheet}
      </>
    );
  }

  return (
    <>
      <SuccessSheet open onOpenChange={() => onDone()} snapPoints={["full"]} title={title} subtitle={subtitle} rows={rows} primary={{ label: "Done", onClick: onDone }}>
        {actions}
      </SuccessSheet>
      {cancelSheet}
    </>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function SendRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet
      label="Send"
      snapPoints={["full"]}
      cold={cold}
      desktop={{
        as: "dialog",
        size: "md",
        title: "Send",
        description: "By link to anyone, or straight to someone with Polaris.",
        className: "bg-ui-canvas",
        content: (
          <Suspense>
            <SendDialogContent />
          </Suspense>
        ),
      }}
    >
      <Suspense>
        <SendSheet />
      </Suspense>
    </RouteSheet>
  );
}
