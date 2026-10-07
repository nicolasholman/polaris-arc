import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import { StatusPill, type StatusPillTone } from "./Chips";

export type RunItem = {
  id: string;
  /** The pill: "Collected", "Paused", "Refused". */
  tag: ReactNode;
  tone: StatusPillTone;
  /** What happened: "2 instalments collected ($100.77)". */
  title: ReactNode;
  /** One muted line under it: counts, reasons, who it was for. */
  detail?: ReactNode;
  /** When: "12 s ago", "Block 41,250,120 · 3 min ago". */
  meta?: ReactNode;
  /** On the right: a transaction link. */
  trailing?: ReactNode;
};

export type RunListProps = {
  items: RunItem[];
  /** Shown in place of the list when there are no items. */
  empty?: ReactNode;
  "aria-label"?: string;
  className?: string;
};

/**
 * A log of runs or events in ref E's table language: a status pill, what
 * happened and a muted line under it, and a link on the right. Below 640px
 * the pill moves in front of the title. For automated jobs (the Chainlink
 * CRE workflows' reports) and event feeds.
 *
 * ```tsx
 * <RunList items={[{ id, tag: "Collected", tone: "lime", title: "2 instalments collected", meta: "12 s ago", trailing: <TxLink … /> }]} />
 * ```
 */
export function RunList({ items, empty, className, ...props }: RunListProps) {
  if (items.length === 0 && empty) return <>{empty}</>;
  return (
    <ul aria-label={props["aria-label"]} className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] font-satoshi", className)}>
      {items.map((item) => (
        <li
          key={item.id}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-ui-hairline py-3 last:border-0 sm:grid-cols-[132px_minmax(0,1fr)_auto]"
        >
          <span className="hidden sm:block">
            <StatusPill tone={item.tone} size="sm">
              {item.tag}
            </StatusPill>
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-medium text-ui-text">
              <span className="sm:hidden">{item.tag} · </span>
              {item.title}
            </span>
            {item.detail || item.meta ? (
              <span className="ui-figure block truncate text-[12.5px] text-ui-muted">{[item.detail, item.meta].filter(Boolean).map((part, i) => (i ? <span key={i}> · {part}</span> : <span key={i}>{part}</span>))}</span>
            ) : null}
          </span>
          {item.trailing ? <span className="shrink-0 text-[13px]">{item.trailing}</span> : <span />}
        </li>
      ))}
    </ul>
  );
}
