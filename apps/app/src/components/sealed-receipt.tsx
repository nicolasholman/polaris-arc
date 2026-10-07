"use client";

import { Button, cn, DetailsList, type KeyValue, Notice, SkeletonText } from "@polaris/ui";
import { LockKeyhole, RotateCcw, ScanFace } from "lucide-react";
import type { ReactNode } from "react";
import { useOwner } from "@/lib/account/hooks";
import type { ActivityItem } from "@/lib/data/types";
import { shortDate } from "@/lib/dates";
import { type Receipt, receiptWhat, useReceipt } from "@/lib/receipts";

/**
 * What was bought, from the receipt sealed to this account's Face ID. The
 * server keeps it as ciphertext; it opens here, with the session's keys
 * (no prompt while the account is open), or with Face ID when it is locked.
 * Nothing at all for a row without a sealed receipt.
 */
export function SealedReceipt({ item, owner, className }: { item: ActivityItem; owner: `0x${string}` | null; className?: string }) {
  const r = useReceipt(item.receiptId, owner);
  if (r.status === "none") return null;

  if (r.status === "open") {
    return (
      <div className={cn("grid gap-2", className)}>
        <DetailsList size="sm" items={receiptRows(r.receipt)} />
        <SealedLine />
      </div>
    );
  }

  if (r.status === "opening") {
    return (
      <Notice tone="neutral" icon={<LockKeyhole />} title="Opening your receipt…" className={className} role="status">
        <SkeletonText lines={2} className="mt-2 w-[220px]" />
      </Notice>
    );
  }

  if (r.status === "error") {
    return (
      <Notice
        tone="down"
        title="This receipt didn't open"
        className={className}
        action={
          <Button variant="white" size="sm" icon={<RotateCcw />} onClick={() => void r.unlock()}>
            Try again
          </Button>
        }
      >
        {r.message}
      </Notice>
    );
  }

  if (r.status === "missing") {
    return (
      <Notice tone="neutral" icon={<LockKeyhole />} title="Only your Face ID can open this" className={className}>
        This receipt didn&apos;t open with this account. It may belong to another account on this device.
      </Notice>
    );
  }

  return (
    <Notice
      tone="neutral"
      icon={<LockKeyhole />}
      title="Only your Face ID can open this"
      className={className}
      action={
        <Button variant="white" size="sm" icon={<ScanFace />} onClick={() => void r.unlock()}>
          Open with Face ID
        </Button>
      }
    >
      What you bought is sealed to your account. Polaris keeps it, but can&apos;t read it.
    </Notice>
  );
}

/** "Sealed to your Face ID": under an opened receipt. */
function SealedLine() {
  return (
    <p className="flex items-center gap-2 px-1 text-[13px] leading-snug text-ui-muted">
      <LockKeyhole aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
      <span>Sealed to your Face ID. Only you can read it.</span>
    </p>
  );
}

const usd = (amount: string) => `$${amount}`;

/** The opened receipt as details rows: what, the line items, the plan or the period, the order. */
export function receiptRows({ body, parent }: Receipt): KeyValue[] {
  const rows: KeyValue[] = [];
  const what = receiptWhat({ body, parent });
  if (what) rows.push({ label: "For", value: what });
  const items = body.lineItems.length ? body.lineItems : (parent?.lineItems ?? []);
  for (const [i, li] of items.entries()) {
    const total = (Number(li.unitAmount) * li.quantity).toFixed(2);
    rows.push({ key: `li-${i}`, label: li.quantity > 1 ? `${li.name} × ${li.quantity}` : li.name, value: usd(total) });
  }
  if (body.installment) rows.push({ label: "Instalment", value: `${body.installment.index} of ${body.installment.of}` });
  const plan = body.plan ?? parent?.plan ?? null;
  if (plan && body.kind === "plan") {
    const next = plan.schedule[0];
    rows.push({ label: "Plan", value: `${plan.installments} payments, ${usd(plan.total)} in all` });
    if (next) rows.push({ label: "First payment", value: `${usd(next.amount)} on ${shortDate(Date.parse(next.dueAt))}` });
  }
  if (body.period !== null && body.kind === "subscription-charge") rows.push({ label: "Period", value: periodLabel(body.period, parent) });
  const sub = body.subscription ?? parent?.subscription ?? null;
  if (sub && body.kind === "subscription") rows.push({ label: "Billed", value: everyLabel(sub) });
  const order = body.orderId ?? parent?.orderId ?? null;
  if (order) rows.push({ label: "Order", value: order });
  if (rows.length === 0) rows.push({ label: "For", value: body.merchant });
  return rows;
}

function everyLabel(s: { interval: string; intervalCount: number }): string {
  return s.intervalCount === 1 ? `Every ${s.interval}` : `Every ${s.intervalCount} ${s.interval}s`;
}

function periodLabel(period: number, parent: Receipt["parent"]): ReactNode {
  const sub = parent?.subscription;
  return sub ? `${ordinal(period)} ${sub.interval}` : `Period ${period}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * A row's "what" on the Activity list: the opened receipt's line when the
 * session has opened it, else the row's own words with a small lock.
 */
export function ReceiptWhat({ item, fallback }: { item: ActivityItem; fallback: string }) {
  const owner = useOwner();
  const r = useReceipt(item.receiptId, owner);
  if (r.status === "none") return <>{fallback}</>;
  const what = r.status === "open" ? receiptWhat(r.receipt) : null;
  if (what) return <>{what}</>;
  // Inline text, not an inline-flex box: a row's ellipsis then cuts the words,
  // where an atomic box would be swapped for "…" whole.
  return (
    <>
      <LockKeyhole aria-label="Sealed receipt" size={12} strokeWidth={2} className="mr-1 inline align-[-1px]" />
      {fallback}
    </>
  );
}
