"use client";

import { CalendarDays } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn";
import { useControllable } from "../lib/hooks";
import { IconSlot } from "../lib/icon";

const THUMB_SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.8 } as const;

/** Arrow keys, Home and End across a row of radios or tabs. */
function rovingKeyDown<T>(
  event: KeyboardEvent,
  values: T[],
  current: T,
  select: (v: T) => void,
  container: HTMLElement | null,
) {
  const i = values.indexOf(current);
  let next = -1;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (i + 1) % values.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (i - 1 + values.length) % values.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = values.length - 1;
  if (next < 0) return;
  event.preventDefault();
  select(values[next]!);
  const buttons = container?.querySelectorAll<HTMLElement>("[data-roving]");
  buttons?.[next]?.focus();
}

/* ── SegmentedControl ────────────────────────────────────────────────────── */

export type SegmentOption<T extends string = string> = { value: T; label: ReactNode; icon?: ReactNode; disabled?: boolean };

export type SegmentedControlProps<T extends string = string> = Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> & {
  options: SegmentOption<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  size?: "sm" | "md" | "lg";
  /** `rounded` (ref B's 12px track) or `pill`. */
  shape?: "rounded" | "pill";
  /** Stretch the segments to the container. */
  block?: boolean;
  /**
   * `text` (the default) or `icon`: square, icon-only segments on a dark glass
   * track, each option's `label` read out instead of shown. Ref B's line /
   * candles toggle on a chart card.
   */
  variant?: "text" | "icon";
  /** Required when there is no visible label. */
  "aria-label"?: string;
};

/**
 * Two to four mutually exclusive options with a sliding white thumb:
 * Market | Limit (ref B), Pay now | Pay in 4.
 *
 * ```tsx
 * <SegmentedControl aria-label="Order type" options={[{ value: "now", label: "Pay now" }, { value: "four", label: "Pay in 4" }]} />
 * ```
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  size = "md",
  shape = "rounded",
  block = false,
  variant = "text",
  className,
  ...props
}: SegmentedControlProps<T>) {
  const [current, setCurrent] = useControllable<T>({
    value,
    defaultValue: defaultValue ?? options[0]!.value,
    onChange: onValueChange,
  });
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const enabled = options.filter((o) => !o.disabled).map((o) => o.value);

  const icons = variant === "icon";
  const h = icons
    ? size === "sm"
      ? "size-8"
      : size === "lg"
        ? "size-11"
        : "size-9"
    : size === "sm"
      ? "h-8 text-[13px] px-3"
      : size === "lg"
        ? "h-11 text-[16px] px-5"
        : "h-9 text-[15px] px-4";
  const track = shape === "pill" ? "rounded-full" : icons ? "rounded-[14px]" : size === "sm" ? "rounded-[10px]" : "rounded-[12px]";
  const thumb = shape === "pill" ? "rounded-full" : size === "sm" ? "rounded-[8px]" : "rounded-[10px]";

  return (
    <div
      ref={ref}
      role="radiogroup"
      className={cn(
        "relative inline-flex items-center font-satoshi",
        icons ? "gap-1 bg-black/15 p-1" : "gap-0.5 bg-ui-surface-3 p-[3px]",
        track,
        block && "flex w-full",
        className,
      )}
      onKeyDown={(e) => rovingKeyDown(e, enabled, current, setCurrent, ref.current)}
      {...props}
    >
      {options.map((o) => {
        const active = o.value === current;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            tabIndex={active ? 0 : -1}
            aria-label={icons && typeof o.label === "string" ? o.label : undefined}
            title={icons && typeof o.label === "string" ? o.label : undefined}
            data-roving=""
            onClick={() => setCurrent(o.value)}
            className={cn(
              "relative inline-flex items-center justify-center gap-1.5 leading-none font-medium whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ui-focus disabled:opacity-40",
              h,
              thumb,
              block && "flex-1",
              active ? "text-[#13141f]" : icons ? "text-white hover:bg-white/10" : "text-ui-text hover:opacity-80",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`${id}-thumb`}
                transition={reduced ? { duration: 0 } : THUMB_SPRING}
                className={cn("absolute inset-0 bg-white shadow-[0_1px_3px_rgb(19_20_31/0.12)]", thumb)}
              />
            ) : null}
            {icons ? (
              <span className="relative inline-flex">
                {o.icon ? <IconSlot size={18}>{o.icon}</IconSlot> : null}
                {typeof o.label === "string" ? null : <span className="sr-only">{o.label}</span>}
              </span>
            ) : (
              <span className="relative inline-flex items-center gap-1.5">
                {o.icon ? <IconSlot size={16}>{o.icon}</IconSlot> : null}
                {o.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── RangeTabs ───────────────────────────────────────────────────────────── */

export type RangeTabsProps<T extends string = string> = Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> & {
  ranges?: T[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  /** Shows the calendar button (ref B) and calls this when pressed. */
  onCalendar?: () => void;
  /** `onColor` sits on a gradient card (ref B); `surface` on a dark or light surface. */
  tone?: "onColor" | "surface";
  "aria-label"?: string;
};

/**
 * 1D 1W 3M 6M All with a white active pill, plus the calendar button (ref B).
 *
 * ```tsx
 * <RangeTabs aria-label="Range" value={range} onValueChange={setRange} onCalendar={openPicker} />
 * ```
 */
export function RangeTabs<T extends string = string>({
  ranges = ["1D", "1W", "3M", "6M", "All"] as T[],
  value,
  defaultValue,
  onValueChange,
  onCalendar,
  tone = "onColor",
  className,
  "aria-label": ariaLabel,
  ...props
}: RangeTabsProps<T>) {
  const [current, setCurrent] = useControllable<T>({
    value,
    defaultValue: defaultValue ?? ranges[0]!,
    onChange: onValueChange,
  });
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const onColor = tone === "onColor";

  return (
    <div className={cn("flex items-center gap-2 font-satoshi", className)} {...props}>
      <div
        ref={ref}
        role="radiogroup"
        aria-label={ariaLabel ?? "Time range"}
        className={cn(
          "flex flex-1 items-center justify-between rounded-[16px] p-1",
          onColor ? "bg-black/15" : "bg-ui-surface-2",
        )}
        onKeyDown={(e) => rovingKeyDown(e, ranges, current, setCurrent, ref.current)}
      >
        {ranges.map((r) => {
          const active = r === current;
          return (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              data-roving=""
              onClick={() => setCurrent(r)}
              className={cn(
                "relative h-9 min-w-[44px] flex-1 rounded-[12px] px-2 text-[15px] leading-none font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white",
                active
                  ? "text-[#13141f]"
                  : onColor
                    ? "text-white/85 hover:text-white"
                    : "text-ui-muted hover:text-ui-text",
              )}
            >
              {active ? (
                <motion.span
                  layoutId={`${id}-range`}
                  transition={reduced ? { duration: 0 } : THUMB_SPRING}
                  className="absolute inset-0 rounded-[12px] bg-white shadow-[0_2px_6px_rgb(0_0_0/0.12)]"
                />
              ) : null}
              <span className="relative">{r}</span>
            </button>
          );
        })}
      </div>
      {onCalendar ? (
        <button
          type="button"
          aria-label="Pick dates"
          title="Pick dates"
          onClick={onCalendar}
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-[14px] transition-[transform,background-color] duration-200 ease-ui-spring active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus motion-reduce:transition-none",
            onColor ? "bg-black/15 text-white hover:bg-black/25" : "bg-ui-surface-2 text-ui-text hover:bg-ui-surface-3",
          )}
        >
          <CalendarDays aria-hidden size={20} strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */

type TabsContextValue = {
  value: string;
  select: (v: string) => void;
  baseId: string;
  variant: "text" | "pill" | "segmented";
  size: "sm" | "md" | "lg";
  reduced: boolean;
  /** Panels on the page right now: a tab only points at a panel that exists. */
  panels: ReadonlySet<string>;
  registerPanel: (value: string) => () => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tab, TabList and TabPanel must sit inside <Tabs>.");
  return ctx;
}

export type TabsProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> & {
  /** The open tab (controlled); or give `defaultValue`. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /**
   * `text`: ref A's large "Expenses  Savings Goals" (active in full text, the rest muted).
   * `pill`: the active tab on a surface pill (dashboard page tabs).
   * `segmented`: a track with a sliding white thumb.
   */
  variant?: "text" | "pill" | "segmented";
  size?: "sm" | "md" | "lg";
};

/**
 * Tabs with panels, keyboard-navigable (arrows, Home, End).
 *
 * ```tsx
 * <Tabs defaultValue="all" variant="pill">
 *   <TabList aria-label="Payments"><Tab value="all">All</Tab><Tab value="paid">Paid</Tab></TabList>
 *   <TabPanel value="all">…</TabPanel>
 * </Tabs>
 * ```
 */
export function Tabs({ value, defaultValue, onValueChange, variant = "pill", size = "md", className, children, ...props }: TabsProps) {
  const [current, select] = useControllable({ value, defaultValue: defaultValue ?? "", onChange: onValueChange });
  const baseId = useId();
  const reduced = useReducedMotion() ?? false;
  const [panels, setPanels] = useState<ReadonlySet<string>>(() => new Set());
  const registerPanel = useCallback((v: string) => {
    setPanels((prev) => (prev.has(v) ? prev : new Set(prev).add(v)));
    return () =>
      setPanels((prev) => {
        if (!prev.has(v)) return prev;
        const next = new Set(prev);
        next.delete(v);
        return next;
      });
  }, []);
  return (
    <TabsContext.Provider value={{ value: current, select, baseId, variant, size, reduced, panels, registerPanel }}>
      <div className={cn("font-satoshi", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export type TabListProps = HTMLAttributes<HTMLDivElement> & { block?: boolean };

export function TabList({ className, children, block = false, ...props }: TabListProps) {
  const { variant, value, select } = useTabs();
  const ref = useRef<HTMLDivElement>(null);
  // When the tabs overflow (a phone), fade the edge that has more to scroll to.
  const [edge, setEdge] = useState<"none" | "end" | "start" | "both">("none");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const more = el.scrollWidth - el.clientWidth;
      if (more <= 1) return setEdge("none");
      const atStart = el.scrollLeft <= 1;
      const atEnd = el.scrollLeft >= more - 1;
      setEdge(atStart ? "end" : atEnd ? "start" : "both");
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=tab]:not([disabled])") ?? []);
    const values = tabs.map((t) => t.dataset.value ?? "");
    rovingKeyDown(e, values, value, select, ref.current);
  };
  return (
    <div
      ref={ref}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn(
        "flex items-center",
        variant === "text" && "gap-6",
        variant === "pill" && "gap-1",
        variant === "segmented" && "gap-0.5 rounded-[12px] bg-ui-surface-3 p-[3px]",
        variant === "segmented" && !block && "inline-flex",
        block && "w-full",
        "ui-no-scrollbar overflow-x-auto",
        edge === "end" && "[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)]",
        edge === "start" && "[mask-image:linear-gradient(to_left,#000_calc(100%-40px),transparent)]",
        edge === "both" && "[mask-image:linear-gradient(to_right,transparent,#000_40px,#000_calc(100%-40px),transparent)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type TabProps = Omit<HTMLAttributes<HTMLButtonElement>, "value"> & {
  value: string;
  disabled?: boolean;
  /** A trailing count ("Pending 3"). */
  count?: number;
};

export function Tab({ value, disabled, count, className, children, ...props }: TabProps) {
  const { value: current, select, baseId, variant, size, reduced, panels } = useTabs();
  const active = current === value;
  const sizes =
    variant === "text"
      ? size === "sm"
        ? "text-[16px]"
        : size === "lg"
          ? "text-[22px]"
          : "text-[20px]"
      : size === "sm"
        ? "h-8 px-3 text-[13px]"
        : size === "lg"
          ? "h-11 px-5 text-[16px]"
          : "h-9 px-4 text-[14px]";
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={active}
      aria-controls={panels.has(value) ? `${baseId}-panel-${value}` : undefined}
      tabIndex={active ? 0 : -1}
      data-value={value}
      data-roving=""
      disabled={disabled}
      onClick={() => select(value)}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center gap-1.5 leading-none font-medium whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-focus disabled:opacity-40",
        sizes,
        variant === "text" && (active ? "tracking-[-0.02em] text-ui-text" : "tracking-[-0.02em] text-ui-muted hover:text-ui-text"),
        variant === "pill" && (active ? "rounded-full text-ui-text" : "rounded-full text-ui-muted hover:text-ui-text"),
        variant === "segmented" && (active ? "flex-1 rounded-[10px] text-[#13141f]" : "flex-1 rounded-[10px] text-ui-text hover:opacity-80"),
        className,
      )}
      {...props}
    >
      {active && variant !== "text" ? (
        <motion.span
          layoutId={`${baseId}-indicator`}
          transition={reduced ? { duration: 0 } : THUMB_SPRING}
          className={cn(
            "absolute inset-0",
            variant === "pill" ? "rounded-full bg-ui-surface-3" : "rounded-[10px] bg-white shadow-[0_1px_3px_rgb(19_20_31/0.12)]",
          )}
        />
      ) : null}
      <span className="relative inline-flex items-center gap-1.5">
        {children}
        {typeof count === "number" ? (
          <span
            className={cn(
              "ui-figure rounded-full px-1.5 py-0.5 text-[11px] leading-none",
              active ? "bg-ui-canvas/60 text-ui-text" : "bg-ui-surface-2 text-ui-muted",
            )}
          >
            {count}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export type TabPanelProps = HTMLAttributes<HTMLDivElement> & { value: string; keepMounted?: boolean };

export function TabPanel({ value, keepMounted = false, className, children, ...props }: TabPanelProps) {
  const { value: current, baseId, registerPanel } = useTabs();
  const active = current === value;
  const rendered = active || keepMounted;
  useEffect(() => (rendered ? registerPanel(value) : undefined), [rendered, value, registerPanel]);
  if (!rendered) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!active}
      tabIndex={0}
      className={cn("focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus", className)}
      {...props}
    >
      {children}
    </div>
  );
}
