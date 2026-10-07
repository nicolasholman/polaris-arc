"use client";

import { Button, Card, IconDisc, Notice, TxLink } from "@polaris/ui";
import { Check, Loader2, PenLine, ScanFace } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { reauthorizePayments } from "@/lib/actions";
import { duePayment, plansNeedingSignature, signAgainState } from "@/lib/collection";
import { receiptUrl } from "@/lib/chain";
import { notifyDataChanged } from "@/lib/data/changes";
import type { Plan } from "@/lib/data/types";
import { shortDate } from "@/lib/dates";
import { usd } from "@/lib/money";

/**
 * Signing again for a lost approval.
 *
 * When a collection fails because Polaris's approval to take the buyer's
 * payments is gone (the chain says InsufficientAllowance), the plan needs
 * one more signature: an ERC-2612 permit to the loan engine, which the
 * relayer carries to PolarisCheckout.reauthorize. Its Reauthorized event
 * starts the Chainlink CRE collections workflow's instant retry, and the
 * plan reads "Collected" as soon as that run lands (the API's chain sync;
 * this polls it every 2 seconds meanwhile).
 */

/** Poll the API every 2 seconds while a retry is on its way, for up to 3 minutes. */
function usePollWhile(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const id = setInterval(() => {
      if (Date.now() - started > 180_000) clearInterval(id);
      else notifyDataChanged();
    }, 2_000);
    return () => clearInterval(id);
  }, [active]);
}

/**
 * The plan's card: "Sign again to pay your instalment" with Face ID, then
 * "Collecting…", then "Collected" with the collection's receipt. For the
 * plan sheet (phone) and the plan drawer (from 1024px).
 */
export function SignAgainCard({ plan, plans, className }: { plan: Plan; plans: Plan[]; className?: string }) {
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const state = signAgainState(plan);
  const waiting = state === "collecting" || (signed && state === "needed");
  usePollWhile(waiting);
  const payment = duePayment(plan);
  const total = plan.instalments.length;

  if (!state && !signed) return null;

  if (state === "collected" && plan.collection?.reauthorized?.collected) {
    const r = plan.collection.reauthorized;
    const collected = r.collected!;
    const seconds = Math.max(0, Math.round((collected.at - r.at) / 1000));
    const url = receiptUrl(collected.txHash);
    return (
      <Card variant="raised" radius="tile" padding="md" className={className} role="status">
        <div className="flex items-start gap-3">
          <IconDisc size="sm" icon={<Check />} className="bg-ui-up/15 text-ui-up" />
          <div className="min-w-0">
            <p className="text-[16px] font-medium">Collected</p>
            <p className="mt-0.5 text-[14px] leading-snug text-ui-muted">
              Your payment went through {seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`} after you signed. The rest follow on their dates.
            </p>
            <TxLink hash={collected.txHash} href={url} kind="receipt" className="mt-2 text-[13px]">
              {url ? "View receipt" : undefined}
            </TxLink>
          </div>
        </div>
      </Card>
    );
  }

  if (waiting) {
    return (
      <Card variant="raised" radius="tile" padding="md" className={className} role="status" aria-live="polite">
        <div className="flex items-start gap-3">
          <IconDisc size="sm" icon={<Loader2 className="animate-spin" />} />
          <div className="min-w-0">
            <p className="text-[16px] font-medium">Signed. Collecting your payment…</p>
            <p className="mt-0.5 text-[14px] leading-snug text-ui-muted">
              {payment ? `${usd(payment.amount)} to ${plan.merchant.name}. ` : ""}This usually takes a few seconds.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card variant="raised" radius="tile" padding="md" className={className}>
      <div className="flex items-start gap-3">
        <IconDisc size="sm" icon={<PenLine />} className="bg-ui-warn/15 text-ui-warn" />
        <div className="min-w-0">
          <p className="text-[16px] font-medium">Sign again to pay your instalment</p>
          <p className="mt-0.5 text-[14px] leading-snug text-ui-muted">
            {payment
              ? `We couldn't take payment ${payment.index + 1} of ${total} (${usd(payment.amount)}, due ${shortDate(payment.dueAt)}): your approval for Polaris to collect it was reset. `
              : "We couldn't take your last payment: your approval for Polaris to collect it was reset. "}
            Confirm once with Face ID and it&apos;s collected right away.
          </p>
          {payment ? <LocalEquivalent amount={payment.amount} className="mt-1 block text-[12.5px]" /> : null}
        </div>
      </div>
      <Button variant="lime" size="md" block icon={<ScanFace />} className="mt-4" onClick={() => setSigning(true)}>
        Sign again with Face ID
      </Button>
      <ConfirmSheet
        open={signing}
        onOpenChange={setSigning}
        title="Sign again"
        summary={`Lets Polaris collect your Pay in 4 payments again${payment ? `, starting with ${usd(payment.amount)} to ${plan.merchant.name} now` : ""}. Nothing else changes.`}
        busyLabel="Signing…"
        onAccount={async (signer) => {
          await reauthorizePayments(signer, plans);
          setSigned(true);
          notifyDataChanged();
        }}
      />
    </Card>
  );
}

/**
 * On Home (phone and desktop): a plan whose payment couldn't be taken
 * because the approval was reset, and the way to fix it.
 */
export function SignAgainNotice({ plans, className }: { plans: Plan[] | undefined; className?: string }) {
  const needing = plansNeedingSignature(plans);
  const first = needing[0];
  if (!first) return null;
  const payment = duePayment(first);
  return (
    <Notice
      tone="warn"
      role="status"
      icon={<PenLine />}
      className={className}
      title="Sign again to pay your instalment"
      action={
        <Button asChild variant="white" size="sm">
          <Link href={`/plans/${first.id}`} scroll={false}>
            Sign again
          </Link>
        </Button>
      }
    >
      {payment ? `${usd(payment.amount)} to ${first.merchant.name} couldn't be collected. ` : `A payment to ${first.merchant.name} couldn't be collected. `}
      One Face ID and it goes through.{needing.length > 1 ? ` (${needing.length} plans)` : ""}
    </Notice>
  );
}
