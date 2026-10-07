"use client";

import { DetailsList, EmptyState, KeyValueGrid, type KeyValue, Money, PrimaryButton, SecondaryButton, Sheet, Skeleton, Ticks, toast } from "@polaris/ui";
import { ExternalLink, SearchX, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActivityAvatar } from "@/components/avatars";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { SealedReceipt } from "@/components/sealed-receipt";
import { cancelSendLink } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { receiptUrl } from "@/lib/chain";
import { getActivity, getContacts, getPlans } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { longDate, time } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { usd } from "@/lib/money";
import { isOpenLink, KIND_LABEL, movesBalance, n, planProgress, signed, statusOf } from "@/lib/view";
import { ActivityAmount, ActivityPill, whatOf } from "./bits";

/** Dark buttons step up a surface on the drawer's own #1D2129. */
const ON_DRAWER = "bg-ui-surface-2 hover:bg-ui-surface-3";

/**
 * Payment details from 1024px (the /activity/[id] route's Drawer), like the
 * merchant's payment drawer: who and the status pill, the amount, the raised
 * tiles (amount, fee, the plan's ticks or the kind, who), then when and what.
 * A link still waiting to be claimed has no receipt yet, only Cancel link.
 */
export function TransactionDrawerContent({ id }: { id: string }) {
  const router = useRouter();
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const contacts = useData(() => getContacts(owner), [owner]);
  const [cancelling, setCancelling] = useState(false);

  const item = activity.value?.find((a) => a.id === id);
  const waiting = item ? isOpenLink(item) : false;
  const cancellable = waiting && Boolean(item?.linkKey);
  useEffect(() => {
    if (cancellable) prefetchDomains("send");
  }, [cancellable]);

  if (!activity.value) {
    return (
      <Sheet.Body className="grid gap-3">
        <Skeleton shape="tile" height={64} />
        <Skeleton shape="tile" height={160} />
      </Sheet.Body>
    );
  }
  if (!item) {
    return (
      <Sheet.Body>
        <EmptyState size="sm" icon={<SearchX />} title="This payment isn't here" description="It may belong to another account on this device." />
      </Sheet.Body>
    );
  }

  const plan =
    item.kind === "instalment" || item.kind === "plan-opened"
      ? (plans.value?.plans.find((p) => p.id === item.planId) ?? plans.value?.plans.find((p) => p.merchant.name === item.counterparty.name))
      : undefined;
  const contact = item.counterparty.kind === "person" ? contacts.value?.find((c) => c.name === item.counterparty.name) : undefined;
  const progress = plan ? planProgress(plan) : null;
  const part = item.detail.match(/(\d+) of (\d+)/);
  // The same merchant or person's other rows, newest first (the merchant
  // drawer's "this customer's other payments").
  const others = item.counterparty.kind === "polaris" ? [] : activity.value.filter((a) => a.id !== item.id && a.title === item.title).slice(0, 3);

  const who: KeyValue =
    item.counterparty.kind === "merchant"
      ? { label: "Merchant", value: item.counterparty.name }
      : item.counterparty.kind === "person"
        ? { label: item.direction === "in" ? "From" : "To", value: item.counterparty.name }
        : { label: "Status", value: statusOf(item) };
  const tiles: KeyValue[] = [
    { label: "Amount", value: usd(item.amount) },
    { label: "Network fee", value: "None" },
    plan && progress
      ? {
          label: "Plan",
          value: (
            <span className="flex items-center gap-3">
              <Ticks done={part ? Number(part[1]) : progress.done} total={progress.total} size="sm" className="w-[88px]" />
              <span className="ui-figure">
                {part ? `${part[1]} of ${part[2]}` : `${progress.done} of ${progress.total}`}
              </span>
            </span>
          ),
        }
      : { label: "Type", value: KIND_LABEL[item.kind] },
    who,
  ];

  return (
    <>
      <Sheet.Body className="grid content-start gap-6">
        <div className="flex items-center gap-3">
          <ActivityAvatar item={item} />
          <div className="min-w-0">
            <p className="truncate text-[18px] font-medium">{item.title}</p>
            <p className="truncate text-[14px] text-ui-muted">{whatOf(item)}</p>
          </div>
          <span className="ml-auto">
            <ActivityPill item={item} />
          </span>
        </div>
        <div>
          <p className="text-[14px] text-ui-muted">
            {!movesBalance(item) ? "Paid by your Pay later line" : item.direction === "in" ? "Came in" : waiting ? "Held for the link" : "Went out"}
          </p>
          <Money
            value={movesBalance(item) ? signed(item) : n(item.amount)}
            signed={movesBalance(item)}
            className={`ui-figure mt-1 block text-[40px] leading-none font-medium tracking-[-0.035em] ${item.direction === "in" ? "text-ui-up" : ""}`}
          />
          <LocalEquivalent amount={item.amount} className="mt-2 text-[14px] text-ui-muted" />
        </div>
        <KeyValueGrid items={tiles} />
        <DetailsList
          size="sm"
          // Whatever the tiles don't already say.
          items={[
            { label: "When", value: `${longDate(item.at)}, ${time(item.at)}` },
            ...(tiles.some((t) => t.label === "Type") ? [] : [{ label: "Type", value: KIND_LABEL[item.kind] }]),
            ...(tiles.some((t) => t.label === "Status") ? [] : [{ label: "Status", value: statusOf(item) }]),
          ]}
        />
        <SealedReceipt item={item} owner={owner} />
        {others.length ? (
          <div>
            <h3 className="text-[14px] font-medium text-ui-muted">More with {item.title}</h3>
            <ul className="mt-1 grid">
              {others.map((o) => (
                <li key={o.id} className="border-b border-ui-hairline last:border-b-0">
                  <button
                    type="button"
                    onClick={() => router.replace(`/activity/${o.id}`, { scroll: false })}
                    className="flex h-14 w-full items-center gap-3 rounded-[12px] text-left transition-colors hover:bg-ui-surface-2/60 focus-visible:outline-2 focus-visible:outline-ui-focus"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px]">{whatOf(o)}</span>
                      <span className="block text-[13px] text-ui-muted">{`${longDate(o.at)}, ${time(o.at)}`}</span>
                    </span>
                    <ActivityAmount item={o} className="text-[15px]" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {waiting ? (
          <p className="text-[13px] leading-relaxed text-ui-muted">
            Nobody has claimed this link yet. Its receipt comes when they do; until then you can take the money back.
          </p>
        ) : null}
      </Sheet.Body>
      <Sheet.Footer className="[&>*]:flex-1">
        {waiting || !receiptUrl(item.txHash) ? null : (
          <SecondaryButton asChild size="lg" iconRight={<ExternalLink />} className={ON_DRAWER}>
            <a href={receiptUrl(item.txHash)!} target="_blank" rel="noopener noreferrer">
              View receipt
            </a>
          </SecondaryButton>
        )}
        {cancellable ? (
          <SecondaryButton size="lg" icon={<Undo2 />} className={`${ON_DRAWER} text-ui-down`} onClick={() => setCancelling(true)}>
            Cancel link
          </SecondaryButton>
        ) : plan ? (
          <PrimaryButton size="lg" onClick={() => router.push(`/plans/${plan.id}`, { scroll: false })}>
            View plan
          </PrimaryButton>
        ) : item.splitId ? (
          <PrimaryButton size="lg" onClick={() => router.push(`/split/${item.splitId}`, { scroll: false })}>
            See the split
          </PrimaryButton>
        ) : contact ? (
          <PrimaryButton size="lg" onClick={() => router.push(`/send?contact=${contact.id}`, { scroll: false })}>
            Send again
          </PrimaryButton>
        ) : null}
      </Sheet.Footer>

      {cancellable && item.linkKey ? (
        <ConfirmSheet
          open={cancelling}
          onOpenChange={setCancelling}
          danger
          title={`Cancel this ${usd(item.amount, { trim: true })} link?`}
          summary="Nobody has claimed it yet. The money comes straight back to your account, and the link stops working."
          confirmLabel="Cancel with Face ID"
          busyLabel="Cancelling…"
          onAccount={async (signer) => {
            await cancelSendLink(signer, item.linkKey!);
            toast({ title: `${usd(item.amount)} is back in your account`, tone: "success" });
          }}
        />
      ) : null}
    </>
  );
}
