import type { Cents, PayMode, PlanState } from "./types";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** `$1,234.56`. */
export function money(cents: Cents): string {
  return usd.format(cents / 100);
}

/** `$1,235` when a figure is context, not a ledger entry. */
export function moneyWhole(cents: Cents): string {
  return usdWhole.format(Math.round(cents / 100));
}

/** Split `$1,234.56` so the cents can be set smaller beside the dollars. */
export function moneyParts(cents: Cents): { dollars: string; cents: string } {
  const [dollars = "$0", fraction = "00"] = money(cents).split(".");
  return { dollars, cents: fraction };
}

/**
 * Parse what a person typed into an amount field. Accepts `200`, `200.5`,
 * `$1,200.00`. Returns null for anything that isn't a positive amount with at
 * most two decimals.
 */
export function parseAmount(input: string): Cents | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = "0", fraction = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/* ── Pay in 4 quote ─────────────────────────────────────────────────────── */

/** The buyer's APR, pro-rated over the plan. Charged to the buyer, never the merchant. */
export const PLAN_APR_BPS = 1_000;
export const PLAN_INSTALLMENTS = 4;
export const PLAN_INTERVAL_DAYS = 7;

/**
 * What a buyer sees for Pay in 4: $200 becomes 4 × $50.38.
 *
 * Interest accrues from checkout to the last instalment (4 × 7 = 28 days) and
 * rounds to the cent. The last instalment absorbs the rounding so the four add
 * up to the total exactly.
 */
export function payInFourQuote(principal: Cents) {
  const days = PLAN_INSTALLMENTS * PLAN_INTERVAL_DAYS;
  const interest = Math.round((principal * PLAN_APR_BPS * days) / (10_000 * 365));
  const total = principal + interest;
  const each = Math.floor(total / PLAN_INSTALLMENTS);
  const last = total - each * (PLAN_INSTALLMENTS - 1);
  return { interest, total, each, last };
}

/* ── Labels ─────────────────────────────────────────────────────────────── */

export const MODE_LABEL: Record<PayMode, string> = {
  now: "Pay now",
  later: "Pay in 4",
  subscribe: "Subscribe",
};

export const PLAN_STATE_LABEL: Record<PlanState, string> = {
  collecting: "Collecting",
  dunning: "Retrying",
  repaid: "Repaid",
  written_off: "Written off",
};

/** `0x1234…abcd`. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/* ── Dates ──────────────────────────────────────────────────────────────── */

const DAY = 86_400_000;

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dateYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDate(iso: string, withYear = false): string {
  return (withYear ? dateYear : dateOnly).format(new Date(iso));
}

export function formatTime(iso: string): string {
  return timeOnly.format(new Date(iso));
}

/** "Today", "Tomorrow", "In 5 days", "2 days overdue". */
export function formatDue(iso: string, now = Date.now()): string {
  const due = new Date(iso);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDue = new Date(due);
  startOfDue.setHours(0, 0, 0, 0);
  const days = Math.round((startOfDue.getTime() - startOfToday.getTime()) / DAY);
  if (days < -1) return `${Math.abs(days)} days overdue`;
  if (days === -1) return "1 day overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 14) return `In ${days} days`;
  return formatDate(iso);
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function formatAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** How long until a time: "in 9 min", "in 3 h", "now". */
export function formatIn(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const min = Math.ceil(diff / 60_000);
  if (min <= 0) return "now";
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `in ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "tomorrow" : `in ${d} days`;
}

export function isToday(iso: string, now = Date.now()): boolean {
  const a = new Date(iso);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
