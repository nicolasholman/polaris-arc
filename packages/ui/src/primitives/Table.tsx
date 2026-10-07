"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import { cn } from "../lib/cn";
import { useControllable } from "../lib/hooks";
import { Skeleton } from "./Feedback";

export type SortState = { key: string; dir: "asc" | "desc" } | null;

export type TableColumn<T> = {
  key: string;
  header: ReactNode;
  /** Numbers and money align right. */
  align?: "left" | "right" | "center";
  width?: CSSProperties["width"];
  /** The cell; defaults to `row[key]`. */
  render?: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  /** Drop the column on narrow screens (`xl`: only from 1280px, e.g. beside a side column). */
  hideBelow?: "sm" | "md" | "lg" | "xl";
  className?: string;
  headerClassName?: string;
};

export type TableProps<T> = {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Makes rows focusable and pressable (Enter/Space), e.g. to open a Drawer. */
  onRowClick?: (row: T, index: number) => void;
  /** Mark the open row. */
  selectedKey?: string;
  /**
   * `lined`: the dashboard ledger, hairline rows on a white card (ref C shell).
   * `rows`: ref D's separate rounded rows on a dark panel.
   * `plain`: ref E's borderless table straight on the panel (see DataTable).
   */
  variant?: "lined" | "rows" | "plain";
  density?: "comfortable" | "compact";
  loading?: boolean;
  loadingRows?: number;
  /** Shown when there are no rows (an EmptyState). */
  empty?: ReactNode;
  /** Read out as the table's name. */
  caption: string;
  showCaption?: boolean;
  sort?: SortState;
  defaultSort?: SortState;
  onSortChange?: (sort: SortState) => void;
  stickyHeader?: boolean;
  className?: string;
};

const HIDE: Record<NonNullable<TableColumn<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * A data table: sortable headers, pressable rows, loading skeletons, an
 * empty slot, columns that drop on narrow screens, and horizontal scroll
 * when it still does not fit.
 *
 * ```tsx
 * <Table caption="Payments" columns={cols} rows={payments} rowKey={(p) => p.id} onRowClick={open} />
 * <Table caption="Recent sales" variant="rows" columns={cols} rows={sales} rowKey={(s) => s.id} />
 * ```
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  variant = "lined",
  density = "comfortable",
  loading = false,
  loadingRows = 5,
  empty,
  caption,
  showCaption = false,
  sort,
  defaultSort = null,
  onSortChange,
  stickyHeader = false,
  className,
}: TableProps<T>) {
  const [sortState, setSort] = useControllable<SortState>({ value: sort, defaultValue: defaultSort, onChange: onSortChange });
  const lined = variant === "lined";
  const plain = variant === "plain";
  const rowH = plain
    ? density === "compact"
      ? "h-12"
      : "h-[54px]"
    : density === "compact"
      ? lined
        ? "h-12"
        : "h-14"
      : lined
        ? "h-[60px]"
        : "h-16";

  const cellPad = plain ? "px-3 sm:px-4 first:pl-3 last:pr-3" : "px-3 first:pl-4 last:pr-4 sm:px-4 sm:first:pl-5 sm:last:pr-5";

  const toggleSort = (key: string) => {
    if (!sortState || sortState.key !== key) setSort({ key, dir: "desc" });
    else if (sortState.dir === "desc") setSort({ key, dir: "asc" });
    else setSort(null);
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T, i: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick?.(row, i);
    }
  };

  return (
    <div className={cn("relative w-full overflow-x-auto font-satoshi", className)}>
      <table
        className={cn(
          "w-full text-ui-text",
          plain ? "border-separate border-spacing-0 text-[16px]" : "text-[14px]",
          lined || plain ? (lined ? "border-collapse" : "") : "border-separate border-spacing-y-2",
        )}
      >
        <caption className={cn(showCaption ? "pb-3 text-left text-[15px] font-medium" : "sr-only")}>{caption}</caption>
        <thead className={cn(stickyHeader && "sticky top-0 z-[1] bg-inherit")}>
          <tr>
            {columns.map((c) => {
              const sorted = sortState?.key === c.key ? sortState.dir : null;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : c.sortable ? "none" : undefined}
                  style={{ width: c.width }}
                  className={cn(
                    plain ? "h-10 text-[14px] font-medium whitespace-nowrap text-ui-muted" : "h-10 text-[13px] font-medium whitespace-nowrap text-ui-muted",
                    cellPad,
                    lined && "border-b border-ui-hairline",
                    ALIGN[c.align ?? "left"],
                    c.hideBelow && HIDE[c.hideBelow],
                    c.headerClassName,
                  )}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-[6px] transition-colors hover:text-ui-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus",
                        sorted && "text-ui-text",
                        c.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {c.header}
                      {sorted === "asc" ? (
                        <ArrowUp aria-hidden size={13} strokeWidth={2} />
                      ) : sorted === "desc" ? (
                        <ArrowDown aria-hidden size={13} strokeWidth={2} />
                      ) : (
                        <ChevronsUpDown aria-hidden size={13} strokeWidth={1.75} className="opacity-60" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: loadingRows }, (_, i) => (
              <tr key={`sk-${i}`} className={rowH} aria-hidden>
                {columns.map((c, j) => (
                  <td
                    key={c.key}
                    className={cn(
                      cellPad,
                      plain ? "" : lined ? "border-b border-ui-hairline" : "bg-ui-surface-2 first:rounded-l-[22px] last:rounded-r-[22px]",
                      c.hideBelow && HIDE[c.hideBelow],
                    )}
                  >
                    <Skeleton
                      height={12}
                      width={j === 0 ? "70%" : "50%"}
                      className={cn(c.align === "right" && "ml-auto")}
                    />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{empty ?? <p className="py-10 text-center text-ui-muted">Nothing here yet.</p>}</td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const key = rowKey(row, i);
              const clickable = Boolean(onRowClick);
              const selected = selectedKey === key;
              return (
                <tr
                  key={key}
                  tabIndex={clickable ? 0 : undefined}
                  aria-current={selected || undefined}
                  onClick={clickable ? () => onRowClick!(row, i) : undefined}
                  onKeyDown={clickable ? (e) => onKey(e, row, i) : undefined}
                  className={cn(
                    "group/row transition-colors duration-150",
                    rowH,
                    clickable && "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ui-focus",
                    lined && clickable && "hover:bg-ui-surface-2",
                    lined && selected && "bg-ui-surface-2",
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        "align-middle",
                        cellPad,
                        plain
                          ? cn(
                              "first:rounded-l-[14px] last:rounded-r-[14px]",
                              clickable && "group-hover/row:bg-ui-surface-1/60",
                              selected && "bg-ui-surface-1",
                            )
                          : lined
                          ? "border-b border-ui-hairline group-last/row:border-b-0"
                          : cn(
                              "bg-ui-surface-2 first:rounded-l-[22px] last:rounded-r-[22px]",
                              clickable && "group-hover/row:bg-ui-surface-3",
                              selected && "bg-ui-surface-3",
                            ),
                        ALIGN[c.align ?? "left"],
                        c.align === "right" && "ui-figure",
                        c.hideBelow && HIDE[c.hideBelow],
                        c.className,
                      )}
                    >
                      {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Two stacked lines for a table cell: a strong title and a muted sub-line. */
export function CellStack({ title, sub, className }: { title: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[14px] font-medium text-ui-text">{title}</div>
      {sub ? <div className="mt-0.5 truncate text-[12.5px] text-ui-muted">{sub}</div> : null}
    </div>
  );
}
