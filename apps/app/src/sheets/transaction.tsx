"use client";

import { Button, DetailsList, EmptyState, Money, Sheet, Skeleton, toast } from "@polaris/ui";
import { ExternalLink, SearchX, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActivityAvatar } from "@/components/avatars";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { SealedReceipt } from "@/components/sealed-receipt";
import { RouteSheet } from "@/components/shell/sheet-host";
import { TransactionDrawerContent } from "@/desktop/transaction";
import { cancelSendLink } from "@/lib/actions";
import { useOwner } from "@/lib/account/hooks";
import { receiptUrl } from "@/lib/chain";
import { getActivity, getContacts, getPlans } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { longDate, time } from "@/lib/dates";
import { prefetchDomains } from "@/lib/domains";
import { usd } from "@/lib/money";
import { isOpenLink, KIND_LABEL, movesBalance, n, signed, statusOf } from "@/lib/view";

/** Payment details (half): the amount, what it was, and the one road to the receipt. */
export function TransactionSheet({ id }: { id: string }) {
  const router = useRouter();
  const owner = useOwner();
  const activity = useData(() => getActivity(owner), [owner]);
  const plans = useData(() => getPlans(owner), [owner]);
  const contacts = useData(() => getContacts(owner), [owner]);
  const [cancelling, setCancelling] = useState(false);

  const item = activity.value?.find((a) => a.id === id);
  const cancellable = item ? isOpenLink(item) && Boolean(item.linkKey) : false;
  useEffect(() => {
    if (cancellable) prefetchDomains("send");
  }, [cancellable]);

  if (!activity.value) {
    return (
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-2 pt-4">
        <Skeleton shape="circle" width={56} height={56} />
        <Skeleton width={160} height={36} />
        <Skeleton shape="tile" height={176} className="w-full" />
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
      ? (plans.value?.plans.find((p) => p.id === item.planId) ??
        plans.value?.plans.find((p) => p.merchant.name === item.counterparty.name && p.status === "active") ??
        plans.value?.plans.find((p) => p.merchant.name === item.counterparty.name))
      : undefined;
  const contact = item.counterparty.kind === "person" ? contacts.value?.find((c) => c.name === item.counterparty.name) : undefined;

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-2 pt-2 text-center">
        <ActivityAvatar item={item} size="lg" />
        <p className="mt-2 text-[16px] font-medium">{item.title}</p>
        <Money
          value={movesBalance(item) ? signed(item) : n(item.amount)}
          signed={movesBalance(item)}
          dim="cents"
          className={`text-[40px] leading-none font-semibold tracking-[-0.035em] ${item.direction === "in" ? "text-ui-up" : ""}`}
        />
        <LocalEquivalent amount={item.amount} className="text-[14px]" />
        <DetailsList
          size="sm"
          className="mt-3 w-full text-left"
          items={[
            { label: "What", value: item.detail },
            { label: "Type", value: KIND_LABEL[item.kind] },
            { label: "When", value: `${longDate(item.at)}, ${time(item.at)}` },
            { label: "Status", value: statusOf(item) },
          ]}
        />
        <SealedReceipt item={item} owner={owner} className="mt-1 w-full text-left" />
      </Sheet.Body>
      <Sheet.Footer className="lg:[&>*]:flex-1">
        {receiptUrl(item.txHash) ? (
          <Button asChild variant="outline" size="lg" iconRight={<ExternalLink />}>
            <a href={receiptUrl(item.txHash)!} target="_blank" rel="noopener noreferrer">
              View receipt
            </a>
          </Button>
        ) : null}
        {cancellable ? (
          <Button variant="dark" size="lg" icon={<Undo2 />} className="text-ui-down" onClick={() => setCancelling(true)}>
            Cancel link
          </Button>
        ) : plan ? (
          <Button variant="lime" size="lg" onClick={() => router.push(`/plans/${plan.id}`, { scroll: false })}>
            View plan
          </Button>
        ) : item.splitId ? (
          <Button variant="lime" size="lg" onClick={() => router.push(`/split/${item.splitId}`, { scroll: false })}>
            See the split
          </Button>
        ) : contact ? (
          <Button variant="lime" size="lg" onClick={() => router.push(`/send?contact=${contact.id}`, { scroll: false })}>
            Send again
          </Button>
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

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function TransactionRoute({ id, cold }: { cold?: boolean } & { id: string }) {
  return (
    <RouteSheet
      label="Payment details"
      cold={cold}
      fallback="/activity"
      desktop={{ as: "drawer", title: "Payment details", content: <TransactionDrawerContent id={id} /> }}
    >
      <TransactionSheet id={id} />
    </RouteSheet>
  );
}
