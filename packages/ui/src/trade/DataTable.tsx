"use client";

import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import { Table, type TableProps } from "../primitives/Table";

export type DataTableProps<T> = Omit<TableProps<T>, "variant">;

/**
 * Ref E's table ("Exchange · BNB/USD · Amount · Diff · Volume"): straight on
 * the panel with no rules, muted 14px headers, 54px rows of 16px text, a
 * small round icon before the first column and status pills in a column of
 * their own. Rows can open a Drawer (`onRowClick`); everything else is the
 * library Table (sorting, loading, empty, columns that drop on phones).
 *
 * The cells keep 12px of padding either side and the table pulls out by the
 * same amount, so its text lines up with the panel while a hovered row gets
 * a rounded highlight with room around it.
 *
 * ```tsx
 * <DataTable
 *   caption="Recent payments"
 *   columns={[
 *     { key: "customer", header: "Customer", render: (p) => <TableName icon={<Avatar … />} title={p.name} /> },
 *     { key: "status", header: "Status", render: (p) => <StatusPill tone="lime">Paid</StatusPill> },
 *     { key: "net", header: "Net", align: "right", render: (p) => money(p.net) },
 *   ]}
 *   rows={payments}
 *   rowKey={(p) => p.id}
 *   onRowClick={open}
 * />
 * ```
 */
export function DataTable<T>({ className, ...props }: DataTableProps<T>) {
  return <Table variant="plain" {...props} className={cn("-mx-3 w-[calc(100%+24px)]", className)} />;
}

/**
 * The first column's cell: a small round icon (an avatar, a coin) and the
 * name, with an optional muted line under it.
 */
export function TableName({ icon, title, sub, className }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-3", className)}>
      {icon ? <span className="inline-flex shrink-0">{icon}</span> : null}
      <span className="min-w-0">
        <span className="block truncate text-[16px] leading-tight font-medium text-ui-text">{title}</span>
        {sub ? <span className="mt-0.5 block truncate text-[13px] leading-tight text-ui-muted">{sub}</span> : null}
      </span>
    </span>
  );
}
