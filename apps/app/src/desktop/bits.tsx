"use client";

import { Coin, cn, type CoinTone, Money, PairHeader, StatusPill, type StatusPillTone, TableName, type TableColumn } from "@polaris/ui";
import type { ReactNode } from "react";
import { ActivityAvatar } from "@/components/avatars";
import { ReceiptWhat } from "@/components/sealed-receipt";
import type { ActivityItem } from "@/lib/data";
import { shortDate, time } from "@/lib/dates";
import { movesBalance, n, signed, when } from "@/lib/view";

/** The status pill for a row: what kind of money it was, in ref E's tints. */
export function activityPill(item: ActivityItem): { tone: StatusPillTone; text: string } {
  if (item.status !== "settled") return { tone: "amber", text: "Processing" };
  const part = item.detail.match(/(\d+) of (\d+)/);
  switch (item.kind) {
    case "payment":
      return { tone: "lime", text: "Paid" };
    case "instalment":
      return { tone: "purple", text: part ? `Pay in 4 · ${part[1]} of ${part[2]}` : "Pay in 4" };
    case "plan-opened":
      return { tone: "purple", text: "Pay in 4 · opened" };
    case "subscription":
      return { tone: "teal", text: "Subscription" };
    case "sent-link":
      if (item.detail === "Waiting to be claimed") return { tone: "amber", text: "Link · waiting" };
      if (item.detail === "Cancelled") return { tone: "neutral", text: "Cancelled" };
      return { tone: "neutral", text: "Sent by link" };
    case "sent":
      return { tone: "neutral", text: "Sent" };
    case "received":
      return { tone: "lime", text: "Received" };
    case "claimed":
      return { tone: "lime", text: "Claimed" };
    case "refund":
      return { tone: "teal", text: "Returned" };
    case "added":
      return { tone: "lime", text: "Added" };
    case "split-paid":
      return { tone: "teal", text: "Split · your share" };
    case "split-received":
      return { tone: "lime", text: "Split · paid you" };
  }
}

/**
 * What a row was for, never its status pill again ("Received" twice): the
 * note when there is one, otherwise who it came from or went to.
 */
export function whatOf(item: ActivityItem): string {
  const first = item.title.split(/\s+/)[0] ?? item.title;
  switch (item.kind) {
    case "received":
      return item.detail && item.detail !== "Received" ? item.detail : `From ${first}`;
    case "sent":
      return item.detail && item.detail !== "Sent" ? item.detail : `To ${first}`;
    case "claimed":
      return item.detail === "Link claimed" ? `${first}'s link, claimed` : item.detail;
    case "sent-link":
      if (item.detail === "Sent by link") return `A link for ${first}`;
      if (item.detail === "Cancelled") return "Taken back";
      return item.detail;
    default:
      return item.detail;
  }
}

export function ActivityPill({ item, size }: { item: ActivityItem; size?: "sm" | "md" }) {
  const pill = activityPill(item);
  return (
    <StatusPill tone={pill.tone} size={size}>
      {pill.text}
    </StatusPill>
  );
}

/** A row's amount: signed when it moved your dollars, plain when it didn't (a plan opening). */
export function ActivityAmount({ item, className }: { item: ActivityItem; className?: string }) {
  if (!movesBalance(item)) return <Money value={n(item.amount)} dim="none" className={cn("ui-figure text-ui-muted", className)} />;
  const v = signed(item);
  return <Money value={v} signed dim="none" className={cn("ui-figure", v > 0 && "text-ui-up", className)} />;
}

type ColumnKey = "who" | "what" | "amount" | "status" | "when";

/**
 * The activity table's columns in ref E's order (Exchange · Pair · Amount ·
 * Diff · Volume): who with a round icon, what, the amount, the status pill
 * and when. `hide` drops columns for a narrower table.
 */
export function activityColumns({
  hide = [],
  whenStyle = "relative",
  narrowWhen = false,
}: { hide?: ColumnKey[]; whenStyle?: "relative" | "full"; /** Drop "When" below 1280px (beside a side column). */ narrowWhen?: boolean } = {}): TableColumn<ActivityItem>[] {
  const all: (TableColumn<ActivityItem> & { key: ColumnKey })[] = [
    {
      key: "who",
      header: "Merchant or person",
      render: (a) => <TableName icon={<ActivityAvatar item={a} size="xs" />} title={a.title} />,
    },
    {
      key: "what",
      header: "What",
      hideBelow: "xl",
      render: (a) => (
        <span className="block max-w-[240px] truncate" title={whatOf(a)}>
          {a.receiptId ? <ReceiptWhat item={a} fallback={whatOf(a)} /> : whatOf(a)}
        </span>
      ),
    },
    { key: "amount", header: "Amount", render: (a) => <ActivityAmount item={a} /> },
    { key: "status", header: "Status", render: (a) => <ActivityPill item={a} /> },
    {
      key: "when",
      header: "When",
      align: "right",
      hideBelow: narrowWhen ? "xl" : undefined,
      render: (a) => (
        whenStyle === "full" ? (
          <span className="ui-figure block whitespace-nowrap">
            <span className="block text-ui-text">{shortDate(a.at)}</span>
            <span className="block text-[13px] text-ui-muted">{time(a.at)}</span>
          </span>
        ) : (
          <span className="ui-figure whitespace-nowrap text-ui-text" title={`${shortDate(a.at)}, ${time(a.at)}`}>
            {when(a.at)}
          </span>
        )
      ),
    },
  ];
  return all.filter((c) => !hide.includes(c.key));
}

/** A page's coin: a flat colour with a white icon, like the reference's ETH coin. */
export function PageCoin({ tone, children, size = 50 }: { tone: CoinTone; children: ReactNode; size?: number }) {
  return (
    <Coin tone={tone} size={size}>
      <span
        className="inline-grid place-items-center [&_svg]:size-full [&_svg]:stroke-[2.25]"
        style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }}
      >
        {children}
      </span>
    </Coin>
  );
}

/** The section title in ref E's rhythm, over a table or a row of cards. */
export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <h2 className="text-[22px] leading-tight font-medium tracking-[-0.02em]">{children}</h2>
      {action}
    </div>
  );
}

/**
 * Every desktop page opens like ref E's chart: overlapping coins, the page's
 * name at the pair's size (the page's h1), and square icon actions on the right.
 */
export function PageHead({ title, coins, actions, className }: { title: string; coins: ReactNode[]; actions?: ReactNode; className?: string }) {
  return (
    <PairHeader
      as="h1"
      className={cn("mb-6", className)}
      coins={coins}
      title={title}
      trailing={actions ? <div className="flex items-center gap-2">{actions}</div> : undefined}
    />
  );
}

/**
 * Ref E's two columns: the page on the left, the widget or summary on the
 * right (sticky from 1280px). `stack`: a page whose table needs the whole
 * width puts the column under it, in two columns, below 1280px; give it two
 * `SideColumn`s then, so each column stacks on its own (a tall card on one
 * side never leaves a hole on the other).
 */
export function PageGrid({ main, side, stack = false, className }: { main: ReactNode; side: ReactNode; stack?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        "grid items-start gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_404px] xl:gap-x-11",
        stack ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_356px]",
        className,
      )}
    >
      <section className="min-w-0">{main}</section>
      <aside className={cn("grid min-w-0 content-start gap-3 xl:sticky xl:top-6", stack && "grid-cols-2 items-start xl:grid-cols-1")}>{side}</aside>
    </div>
  );
}

/** One of a stacked `PageGrid`'s two side columns (one above the other from 1280px). */
export function SideColumn({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 content-start gap-3">{children}</div>;
}

/** A muted note under a column's buttons. */
export function SideNote({ children }: { children: ReactNode }) {
  return <p className="px-1 text-[13px] leading-relaxed text-ui-muted">{children}</p>;
}
