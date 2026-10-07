"use client";

import {
  Avatar,
  Button,
  DetailsList,
  EmptyState,
  GradientCard,
  ListGroup,
  ListRow,
  Money,
  Notice,
  PrimaryButton,
  ScreenHeader,
  SecondaryButton,
  Sheet,
  Skeleton,
  StatusPill,
  SuccessCheck,
  Ticks,
  toast,
  useIsDesktop,
} from "@polaris/ui";
import { Check, CircleCheck, Copy, ExternalLink, Link2Off, Plus, ScanFace, Share2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { QrCode } from "@/components/qr";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { SuccessSheet } from "@/components/success-sheet";
import { closeSplit, payShare } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { useOrigin } from "@/lib/browser";
import { getBalance, getSplit, type SplitStatus } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { longDate, time } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { type Micros, usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import {
  knownSplit,
  memoMatches,
  onKnownSplitsChanged,
  parseSplitFragment,
  rememberSplit,
  shareLabel,
  type SplitMemo,
  splitUrl,
} from "@/lib/split";
import { n, when } from "@/lib/view";

/**
 * The split link, `/split/<id>#<words>`: one page, two people.
 *
 *   A friend   sees what it's for, who asked, the progress ("2 of 3 paid"),
 *              picks their name if the shares are named, and pays their share
 *              with Face ID (creating their account in the same step, as a
 *              send link's claim does). The dollars go straight to the
 *              organiser.
 *   The organiser (this device's account made it) sees who paid and when,
 *              shares the link again (Remind), or closes it: unpaid shares
 *              can't be paid after, and nothing moves.
 *
 * The amounts and who paid come from the chain (PolarisSplit, through the
 * API). The words come from the link's fragment, or from this device if it
 * made or opened the link before, and are shown only when they hash to what
 * the organiser signed. A share wears its name's initials, never a stock
 * photo: the name is whatever the organiser typed.
 */

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  const off = onKnownSplitsChanged(onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
    off();
  };
};

type Words = {
  memo: SplitMemo | null;
  /** The link had words that don't match what the organiser signed. */
  mismatch: boolean;
};

/** The split's words: the link's if they check out, else this device's, else none. */
function useSplitWords(split: SplitStatus | undefined, id: Hex): Words {
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
  if (!split) return { memo: null, mismatch: false };
  const fromLink = parseSplitFragment(hash);
  if (memoMatches(fromLink, split.memoHash)) return { memo: fromLink, mismatch: false };
  const known = knownSplit(id)?.memo ?? null;
  if (memoMatches(known, split.memoHash)) return { memo: known, mismatch: fromLink !== null };
  return { memo: null, mismatch: fromLink !== null };
}

function statusText(split: SplitStatus): { tone: "lime" | "amber" | "neutral" | "red"; text: string } {
  switch (split.status) {
    case "settled":
      return { tone: "lime", text: "Everyone paid" };
    case "closed":
      return { tone: "neutral", text: "Closed" };
    case "expired":
      return { tone: "neutral", text: "Expired" };
    default:
      // The line beside it already says "2 of 3 paid".
      return { tone: "amber", text: "Collecting" };
  }
}

/** The page, as a sheet (phone) or a Dialog (from 1024px). */
export function SplitSheet({ id }: { id: Hex }) {
  const close = useCloseSheet();
  const owner = useOwner();
  const split = useData(() => getSplit(id, owner), [id, owner]);
  const words = useSplitWords(split.value ?? undefined, id);
  const organiser = Boolean(split.value && owner && split.value.organiser.toLowerCase() === owner.toLowerCase());

  useEffect(() => prefetchDomains("ausd", "split"), []);

  // A friend who opened the link keeps its words here, for their Activity.
  const s = split.value;
  const origin = useOrigin();
  useEffect(() => {
    if (!s || !words.memo || !origin || organiser) return;
    if (knownSplit(id)) return;
    rememberSplit(id, { memo: words.memo, url: splitUrl(origin, id, words.memo), role: "friend", at: Date.now() });
  }, [s, words.memo, origin, organiser, id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title={organiser ? "Your split" : "Split"} onBack={close} className="-mt-2 shrink-0 px-5 lg:hidden" />
      {split.value === undefined && split.status !== "error" ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
          <Skeleton shape="card" height={190} />
          <Skeleton shape="tile" height={220} />
        </Sheet.Body>
      ) : split.status === "error" && !split.value ? (
        <Sheet.Body className="pt-6">
          <EmptyState
            icon={<Link2Off />}
            title="We couldn't open this split"
            description="Check your connection and try again. Nothing was charged."
            action={
              <Button variant="white" size="lg" onClick={() => split.reload()}>
                Try again
              </Button>
            }
          />
        </Sheet.Body>
      ) : !split.value ? (
        <Sheet.Body className="pt-6">
          <EmptyState
            icon={<Link2Off />}
            title="This split isn't here"
            description="The link may be incomplete, or on another network. Ask whoever sent it to share it again."
            action={
              <Button variant="white" size="lg" onClick={close}>
                Go to Polaris
              </Button>
            }
          />
        </Sheet.Body>
      ) : organiser ? (
        <OrganiserView split={split.value} memo={words.memo} onDone={close} />
      ) : (
        <FriendView split={split.value} words={words} owner={owner} onDone={close} />
      )}
    </div>
  );
}

/* ── Shared pieces ──────────────────────────────────────────────────────── */

/** The headline card: ref A's lime gradient on a phone, ref E's olive from 1024px. */
function HeadCard({ label, value, meta }: { label: string; value: Micros; meta: ReactNode }) {
  const desktop = useIsDesktop();
  return (
    <GradientCard
      tone="lime"
      label={label}
      value={<Money value={n(value)} dim="symbol" dimOpacity={0.4} />}
      meta={<span className="text-[16px] font-medium">{meta}</span>}
      className="min-h-[176px]"
      style={desktop ? { background: "var(--ui-lime-button)" } : undefined}
    />
  );
}

/** "2 of 3 paid" with a tick per share, and what has come in. */
function Progress({ split }: { split: SplitStatus }) {
  const pill = statusText(split);
  return (
    <div className="grid gap-3 rounded-ui-tile bg-ui-surface-1 p-4 lg:bg-ui-surface-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-medium">
          {split.paidCount} of {split.shareCount} paid
        </p>
        <StatusPill tone={pill.tone} size="sm">
          {pill.text}
        </StatusPill>
      </div>
      <Ticks done={split.paidCount} total={split.shareCount} label={`${split.paidCount} of ${split.shareCount} shares paid`} />
      <p className="ui-figure text-[14px] text-ui-muted">
        {usd(split.paid)} of {usd(split.total)} collected
      </p>
    </div>
  );
}

function shareStatus(split: SplitStatus, index: number, you: Address | null): string {
  const share = split.shares[index]!;
  if (share.paid) {
    const mine = you && share.payer?.toLowerCase() === you.toLowerCase();
    return `${mine ? "You paid" : "Paid"}${share.paidAt ? ` · ${when(share.paidAt)}` : ""}`;
  }
  if (split.status === "closed") return "Cancelled";
  if (split.status === "expired") return "Not paid";
  return "Waiting";
}

/* ── The organiser ──────────────────────────────────────────────────────── */

function OrganiserView({ split, memo, onDone }: { split: SplitStatus; memo: SplitMemo | null; onDone: () => void }) {
  const desktop = useIsDesktop();
  const origin = useOrigin();
  const owner = useOwner();
  const [closing, setClosing] = useState(false);
  const known = knownSplit(split.id);
  // The link as made on this device; elsewhere, the same split without its words (friends then see "Share 2").
  const url = known?.url ?? (origin ? splitUrl(origin, split.id, memo ?? { description: "", organiserName: "", billTotal: 0n, labels: [] }) : null);
  const open = split.status === "open";
  const unpaid = split.shareCount - split.paidCount;
  const what = memo?.description || "Your split";

  async function remind() {
    if (!url) return;
    const waiting = split.shares.filter((s) => !s.paid).map((s) => shareLabel(memo, s.index));
    const text = `${what}: ${split.paidCount} of ${split.shareCount} paid. ${waiting.length <= 3 ? `${waiting.join(", ")}, your share is waiting. ` : ""}Pay it here, in a second:`;
    if (navigator.share) {
      try {
        await navigator.share({ title: what, text, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copy();
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied", description: "Send it to whoever hasn't paid yet.", tone: "success" });
    } catch {
      toast({ title: "Couldn't copy the link", tone: "error" });
    }
  }

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
        <HeadCard label="Collected so far" value={split.paid} meta={<>of {usd(split.total)} · {what}</>} />
        <LocalEquivalent amount={split.paid} className="-mt-1 text-center text-[14px]" />
        <Progress split={split} />
        <ListGroup label="Who paid">
          {split.shares.map((share) => (
            <ListRow
              key={share.index}
              well={false}
              icon={<Avatar name={shareLabel(memo, share.index)} decorative />}
              title={shareLabel(memo, share.index)}
              description={shareStatus(split, share.index, owner)}
              trailing={
                <span className={`ui-figure text-[15px] ${share.paid ? "text-ui-up" : "text-ui-muted"}`}>
                  {share.paid ? "+" : ""}
                  {usd(share.amount)}
                </span>
              }
              chevron={false}
            />
          ))}
        </ListGroup>
        {split.status === "closed" ? (
          <Notice tone="neutral" icon={<XCircle />} title="You closed this split">
            {split.paidCount} of {split.shareCount} paid. The rest was cancelled; nobody can pay it now.
          </Notice>
        ) : split.status === "settled" ? (
          <Notice tone="lime" icon={<CircleCheck />} title="Everyone paid">
            All {usd(split.total)} is in your account.
          </Notice>
        ) : split.status === "expired" ? (
          <Notice tone="neutral" title="This split has expired">
            {split.paidCount} of {split.shareCount} paid. Nobody can pay it now.
          </Notice>
        ) : null}
        {open && url ? (
          <div className="flex flex-col items-center gap-3 pt-1">
            <QrCode value={url} size={132} label="QR code of your split link" />
            <p className="text-center text-[13px] text-ui-muted">Pays out as each share lands. Open until {longDate(split.expiresAt)}.</p>
          </div>
        ) : null}
        <DetailsList
          size="sm"
          items={[
            { label: "Your part", value: memo && memo.billTotal > split.total ? usd(memo.billTotal - split.total) : "None" },
            { label: "Bill", value: memo && memo.billTotal > 0n ? usd(memo.billTotal) : usd(split.total) },
            { label: "Fee", value: "None" },
            ...(split.createdAt ? [{ label: "Opened", value: `${longDate(split.createdAt)}, ${time(split.createdAt)}` }] : []),
          ]}
        />
      </Sheet.Body>
      <Sheet.Footer className={open ? "flex-col gap-2" : "[&>*]:flex-1"}>
        {open ? (
          <>
            <div className="grid w-full grid-cols-2 gap-2">
              {desktop ? (
                // Ref E's pair: two quiet buttons of one size, the primary action being the share itself.
                <>
                  <SecondaryButton size="lg" icon={<Share2 />} className="bg-ui-surface-2 hover:bg-ui-surface-3" onClick={() => void remind()}>
                    Remind
                  </SecondaryButton>
                  <SecondaryButton size="lg" icon={<Copy />} className="bg-ui-surface-2 hover:bg-ui-surface-3" onClick={() => void copy()}>
                    Copy link
                  </SecondaryButton>
                </>
              ) : (
                <>
                  <Button variant="white" size="lg" icon={<Share2 />} onClick={() => void remind()}>
                    Remind
                  </Button>
                  <Button variant="dark" size="lg" icon={<Copy />} onClick={() => void copy()}>
                    Copy link
                  </Button>
                </>
              )}
            </div>
            <Button variant="ghost" size="sm" className="text-ui-down" onClick={() => setClosing(true)}>
              Close split
            </Button>
          </>
        ) : desktop ? (
          <PrimaryButton size="lg" onClick={onDone}>
            Done
          </PrimaryButton>
        ) : (
          <Button variant="lime" size="lg" onClick={onDone}>
            Done
          </Button>
        )}
      </Sheet.Footer>
      <ConfirmSheet
        open={closing}
        onOpenChange={setClosing}
        danger
        title="Close this split?"
        summary={
          unpaid > 0
            ? `${unpaid === 1 ? "The unpaid share is" : `The ${unpaid} unpaid shares are`} cancelled, and the link stops working. What's been paid stays with you.`
            : "The link stops working. What's been paid stays with you."
        }
        confirmLabel="Close with Face ID"
        busyLabel="Closing…"
        onAccount={async (signer) => {
          await closeSplit(signer, split.id);
          toast({ title: "Split closed", description: `${split.paidCount} of ${split.shareCount} paid.`, tone: "success" });
        }}
      />
    </>
  );
}

/* ── A friend ───────────────────────────────────────────────────────────── */

function FriendView({ split, words, owner, onDone }: { split: SplitStatus; words: Words; owner: Address | null; onDone: () => void }) {
  const router = useRouter();
  const desktop = useIsDesktop();
  const balance = useData(() => getBalance(owner), [owner]);
  const { memo } = words;
  const who = memo?.organiserName || "Someone";
  const what = memo?.description || "A split";
  const named = Boolean(memo?.labels.some((l) => l));
  const mine = owner ? split.shares.find((s) => s.payer?.toLowerCase() === owner.toLowerCase()) : undefined;
  const unpaid = split.shares.filter((s) => !s.paid);
  // Named shares: the friend picks theirs. Equal, unnamed ones: the next unpaid share is theirs.
  const [picked, setPicked] = useState<number | null>(null);
  const choice = named ? (picked !== null && !split.shares[picked]?.paid ? picked : null) : (unpaid[0]?.index ?? null);
  const share = choice !== null ? split.shares[choice]! : null;
  const [confirming, setConfirming] = useState(false);
  const [paid, setPaid] = useState<{ receipt: RelayReceipt; index: number } | null>(null);
  const open = split.status === "open";
  const available = balance.value?.available;
  const short = Boolean(owner && share && available !== undefined && available < share.amount);

  const receiptRows = (index: number) => [
    { label: "For", value: what },
    { label: "Share", value: shareLabel(memo, index) },
    { label: "To", value: who },
    { label: "Amount", value: usd(split.shares[index]!.amount) },
    { label: "Fee", value: "None" },
  ];

  if (paid && desktop) {
    return (
      <PaidHere
        subtitle={`${usd(split.shares[paid.index]!.amount)} went straight to ${who}.`}
        rows={receiptRows(paid.index)}
        receiptUrl={paid.receipt.explorerUrl}
        onDone={onDone}
      />
    );
  }

  const headValue = share?.amount ?? mine?.amount ?? (split.shares.length ? split.shares[0]!.amount : 0n);

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
        <HeadCard
          label={mine ? "You paid your share" : named && choice === null ? `${who} asked you to split` : "Your share"}
          value={mine ? mine.amount : headValue}
          meta={
            <>
              {what}
              {memo && memo.billTotal > 0n ? <span className="font-normal opacity-70"> · {usd(memo.billTotal)} bill</span> : null}
            </>
          }
        />
        <LocalEquivalent amount={mine ? mine.amount : headValue} className="-mt-1 text-center text-[14px]" />
        <Progress split={split} />

        {words.mismatch ? (
          <Notice tone="neutral" title="Names hidden">
            The names in this link don&apos;t match what {memo?.organiserName ? who : "the organiser"} set, so they&apos;re not shown.
          </Notice>
        ) : null}

        <ListGroup label={named && open && !mine ? "Which one is you?" : "Shares"}>
          {split.shares.map((s) => {
            const selectable = named && open && !mine && !s.paid;
            const selected = choice === s.index && named;
            return (
              <ListRow
                key={s.index}
                well={false}
                icon={<Avatar name={shareLabel(memo, s.index)} decorative />}
                title={shareLabel(memo, s.index)}
                description={shareStatus(split, s.index, owner)}
                trailing={
                  <span className="flex items-center gap-2">
                    <span className={`ui-figure text-[15px] ${s.paid ? "text-ui-muted line-through decoration-1" : ""}`}>{usd(s.amount)}</span>
                    {selected ? <Check aria-label="You" size={18} className="text-ui-lime lg:text-ui-lime-text" /> : null}
                  </span>
                }
                chevron={false}
                onClick={selectable ? () => setPicked(s.index) : undefined}
                aria-pressed={selectable ? selected : undefined}
              />
            );
          })}
        </ListGroup>

        {split.status === "closed" ? (
          <Notice tone="neutral" icon={<XCircle />} title={`${who} closed this split`}>
            Nothing more is owed on it{mine ? "" : ", and nothing was charged"}.
          </Notice>
        ) : split.status === "settled" && !mine ? (
          <Notice tone="lime" icon={<CircleCheck />} title="Everyone has paid">
            There&apos;s nothing left to pay on this split.
          </Notice>
        ) : split.status === "expired" ? (
          <Notice tone="neutral" title="This split has expired">
            It can&apos;t be paid any more. Ask {who} for a new link if you still owe.
          </Notice>
        ) : null}

        {short && share && open && !mine ? (
          <p role="status" className="rounded-ui-tile bg-ui-surface-2 p-4 text-center text-[15px] leading-[1.45]">
            <span className="font-medium">Your share is {usd(share.amount)}.</span>{" "}
            <span className="text-ui-muted">You have {usd(available ?? 0n)}. Add money, then pay it here.</span>
          </p>
        ) : null}
      </Sheet.Body>
      <Sheet.Footer className="lg:[&>*]:flex-1">
        {mine || !open ? (
          desktop ? (
            <PrimaryButton size="lg" onClick={onDone}>
              Done
            </PrimaryButton>
          ) : (
            <Button variant="lime" size="lg" onClick={onDone}>
              Done
            </Button>
          )
        ) : short ? (
          desktop ? (
            <PrimaryButton size="lg" icon={<Plus />} onClick={() => router.push("/add", { scroll: false })}>
              Add money
            </PrimaryButton>
          ) : (
            <Button variant="lime" size="lg" icon={<Plus />} onClick={() => router.push("/add", { scroll: false })}>
              Add money
            </Button>
          )
        ) : desktop ? (
          <PrimaryButton size="lg" icon={<ScanFace />} disabled={!share} onClick={() => setConfirming(true)}>
            {share ? `Pay ${usd(share.amount, { trim: true })}` : "Pick your name"}
          </PrimaryButton>
        ) : (
          <Button variant="lime" size="lg" icon={<ScanFace />} disabled={!share} onClick={() => setConfirming(true)}>
            {share ? `Pay ${usd(share.amount, { trim: true })}` : "Pick your name"}
          </Button>
        )}
      </Sheet.Footer>

      {share ? (
        <ConfirmSheet
          open={confirming}
          onOpenChange={setConfirming}
          title={`Pay ${usd(share.amount, { trim: true })} to ${who}`}
          summary={`${named ? `${shareLabel(memo, share.index)}'s share` : "Your share"} of ${what}. It goes straight to ${who}, in under a second. No fee.`}
          newLabel="Pay with Face ID"
          busyLabel="Paying…"
          onAccount={async (signer) => {
            const funds = await getBalance(signer.address);
            const receipt = await payShare(signer, split, share.index, { balance: funds.available });
            setPaid({ receipt, index: share.index });
          }}
        />
      ) : null}
      {paid && !desktop ? (
        <SuccessSheet
          open
          onOpenChange={() => onDone()}
          title="Paid."
          subtitle={`${usd(split.shares[paid.index]!.amount)} went straight to ${who}.`}
          rows={receiptRows(paid.index)}
          receiptUrl={paid.receipt.explorerUrl}
          primary={{ label: "Done", onClick: onDone }}
        />
      ) : null}
    </>
  );
}

/** The receipt in the split's own Dialog (1024px and up), as a claim's is. */
function PaidHere({ subtitle, rows, receiptUrl, onDone }: { subtitle: string; rows: { label: string; value: string }[]; receiptUrl: string | null; onDone: () => void }) {
  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-2 pt-6 text-center">
        <SuccessCheck label="Paid" size={80} />
        <h2 className="mt-3 text-[34px] leading-none font-semibold tracking-[-0.035em]">Paid.</h2>
        <p role="status" className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
          {subtitle}
        </p>
        <DetailsList size="sm" items={rows} className="mt-3 w-full text-left" />
      </Sheet.Body>
      <Sheet.Footer className="[&>*]:flex-1">
        {receiptUrl ? (
          <SecondaryButton asChild size="lg" iconRight={<ExternalLink />} className="bg-ui-surface-2 hover:bg-ui-surface-3">
            <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
              View receipt
            </a>
          </SecondaryButton>
        ) : null}
        <PrimaryButton size="lg" onClick={onDone}>
          Done
        </PrimaryButton>
      </Sheet.Footer>
    </>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over Home). */
export function SplitRoute({ id, cold }: { id: Hex; cold?: boolean }) {
  return (
    <RouteSheet
      label="Split"
      snapPoints={["full"]}
      cold={cold}
      desktop={{ as: "dialog", size: "md", title: "Split", description: "Everyone pays their share by link, in dollars." }}
    >
      <SplitSheet id={id} />
    </RouteSheet>
  );
}

