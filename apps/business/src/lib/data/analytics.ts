import type { Cents, PayMode, Payment } from "./types";

/**
 * The Overview's charts, derived from the payments list. Pure functions: the
 * same payments always draw the same charts.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const paid = (payments: Payment[]) => payments.filter((p) => p.status === "succeeded");
const at = (p: Payment) => new Date(p.createdAt).getTime();
/**
 * A payment's time, never later than `now`. A row can be newer than the
 * caller's clock (the page's clock was read before the last refresh, or the
 * chain's block time runs ahead of this machine's); it happened, so it counts
 * as now rather than falling out of every trailing window.
 */
const atMost = (p: Payment, now: number) => Math.min(at(p), now);

/** The change against the previous period; null when there was nothing to compare with. */
function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export type SalesSummary = {
  grossCents: Cents;
  /** Against the period before; null when there was nothing to compare with. */
  deltaPct: number | null;
  /** Daily gross over the period, oldest first, in dollars. */
  spark: number[];
  count: number;
};

/** Gross sales over the last `days`, with the change against the `days` before. */
export function salesSummary(payments: Payment[], { days = 30, mode, now = Date.now() }: { days?: number; mode?: PayMode; now?: number } = {}): SalesSummary {
  const end = now;
  const start = startOfDay(now) - (days - 1) * DAY;
  const prevStart = start - days * DAY;
  const list = paid(payments).filter((p) => !mode || p.mode === mode);
  let gross = 0;
  let prev = 0;
  let count = 0;
  const spark = Array.from({ length: days }, () => 0);
  for (const p of list) {
    const t = atMost(p, end);
    if (t >= start) {
      gross += p.amountCents;
      count += 1;
      const i = Math.floor((t - start) / DAY);
      if (i >= 0 && i < days) spark[i]! += p.amountCents / 100;
    } else if (t >= prevStart && t < start) prev += p.amountCents;
  }
  return { grossCents: gross, deltaPct: pctChange(gross, prev), spark, count };
}

export type ModeSplit = { mode: PayMode; cents: Cents; share: number }[];

/** Gross by payment mode over the last `days`, with each mode's share in %. */
export function salesByMode(payments: Payment[], { days = 30, now = Date.now() } = {}): ModeSplit {
  const start = startOfDay(now) - (days - 1) * DAY;
  const totals: Record<PayMode, number> = { now: 0, later: 0, subscribe: 0 };
  for (const p of paid(payments)) if (atMost(p, now) >= start) totals[p.mode] += p.amountCents;
  const modes = ["now", "later", "subscribe"] as const;
  const shares = wholeShares(modes.map((m) => totals[m]));
  return modes.map((mode, i) => ({ mode, cents: totals[mode], share: shares[i]! }));
}

/**
 * Whole percentages that always add up to 100 (largest remainder): the
 * rounded-down shares, then one more point to the biggest remainders.
 */
export function wholeShares(values: number[]): number[] {
  const sum = values.reduce((s, v) => s + v, 0);
  if (sum <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / sum) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

export type PeriodSummary = {
  gross: Cents;
  fees: Cents;
  net: Cents;
  /** Paid payments. */
  count: number;
  failed: number;
  /** Gross against the same number of days before; null with nothing to compare. */
  delta: number | null;
  modes: ModeSplit;
};

/**
 * The last `days` (today and the days before, from local midnight), the
 * same window as `salesByMode`, so the Overview and Payments agree.
 */
export function periodSummary(payments: Payment[], { days = 30, now = Date.now() } = {}): PeriodSummary {
  const start = startOfDay(now) - (days - 1) * DAY;
  const prevStart = start - days * DAY;
  let gross = 0;
  let fees = 0;
  let net = 0;
  let count = 0;
  let failed = 0;
  let prev = 0;
  // The net in micro-units when every payment has them: summed first, truncated once, like the balance.
  let netUnits: bigint | null = 0n;
  for (const p of payments) {
    const t = atMost(p, now);
    if (t >= start) {
      if (p.status === "succeeded") {
        gross += p.amountCents;
        fees += p.feeCents;
        net += p.netCents;
        netUnits = netUnits !== null && p.netUnits !== undefined ? netUnits + BigInt(p.netUnits) : null;
        count += 1;
      } else failed += 1;
    } else if (p.status === "succeeded" && t >= prevStart && t < start) prev += p.amountCents;
  }
  if (netUnits !== null && count > 0) {
    net = Number(netUnits / 10_000n);
    fees = gross - net;
  }
  return { gross, fees, net, count, failed, delta: pctChange(gross, prev), modes: salesByMode(payments, { days, now }) };
}

export type WeekCustomers = {
  days: { label: string; value: number; today: boolean; future: boolean }[];
  total: number;
  /** Unique buyers this week so far, against the same days last week. */
  deltaPct: number | null;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Unique buyers per day this week, Monday to Sunday. */
export function customersThisWeek(payments: Payment[], now = Date.now()): WeekCustomers {
  const today = startOfDay(now);
  const dow = (new Date(today).getDay() + 6) % 7; // Monday = 0
  const monday = today - dow * DAY;
  const perDay = Array.from({ length: 7 }, () => new Set<string>());
  const week = new Set<string>();
  const lastWeek = new Set<string>();
  for (const p of paid(payments)) {
    const t = atMost(p, now);
    if (t >= monday && t < monday + 7 * DAY) {
      perDay[Math.floor((t - monday) / DAY)]!.add(p.buyer);
      week.add(p.buyer);
    } else if (t >= monday - 7 * DAY && t < monday - 7 * DAY + (dow + 1) * DAY) {
      lastWeek.add(p.buyer);
    }
  }
  return {
    days: perDay.map((set, i) => ({ label: WEEKDAYS[i]!, value: set.size, today: i === dow, future: i > dow })),
    total: week.size,
    deltaPct: pctChange(week.size, lastWeek.size),
  };
}

export type VolumeCandle = { t: number; o: number; h: number; l: number; c: number };
export type VolumeFrame = "1W" | "1M" | "3M";

const FRAMES: Record<VolumeFrame, { bucket: number; count: number }> = {
  "1W": { bucket: 6 * HOUR, count: 28 },
  "1M": { bucket: DAY, count: 30 },
  "3M": { bucket: 3 * DAY, count: 30 },
};

/**
 * Payment volume as candles: the rolling 24-hour volume in dollars, sampled
 * hourly. Each candle opens and closes at that volume at its bucket's start
 * and end, with the bucket's highest and lowest in between. Up means the
 * last 24 hours were busier than when the bucket began.
 */
export function volumeCandles(payments: Payment[], frame: VolumeFrame, now = Date.now()): VolumeCandle[] {
  const { bucket, count } = FRAMES[frame];
  const end = Math.floor(now / HOUR) * HOUR;
  const start = end - bucket * count;
  const events = paid(payments)
    .map((p) => ({ t: atMost(p, end), v: p.amountCents / 100 }))
    .filter((e) => e.t >= start - DAY)
    .sort((a, b) => a.t - b.t);

  // Rolling 24h sum at each hour from `start` to `end`.
  const hours = Math.round((end - start) / HOUR);
  const rolling: number[] = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let h = 0; h <= hours; h++) {
    const t = start + h * HOUR;
    while (hi < events.length && events[hi]!.t <= t) sum += events[hi++]!.v;
    while (lo < hi && events[lo]!.t <= t - DAY) sum -= events[lo++]!.v;
    rolling.push(Math.max(0, Math.round(sum * 100) / 100));
  }
  const perBucket = Math.round(bucket / HOUR);
  return Array.from({ length: count }, (_, i) => {
    const slice = rolling.slice(i * perBucket, (i + 1) * perBucket + 1);
    return {
      t: start + i * bucket,
      o: slice[0] ?? 0,
      c: slice[slice.length - 1] ?? 0,
      h: Math.max(...slice),
      l: Math.min(...slice),
    };
  });
}

/** The average close, for the chart's purple reference line. */
export function averageClose(candles: VolumeCandle[]): number {
  if (!candles.length) return 0;
  return Math.round((candles.reduce((s, c) => s + c.c, 0) / candles.length) * 100) / 100;
}

/* ── The Overview's big chart (ref E): sales as a line over a timeframe ── */

export type SeriesFrame = "1h" | "24h" | "1w" | "1m";

const MINUTE = 60_000;

/**
 * Each timeframe's span and how often it is sampled. `window` is the trailing
 * window the candles sum (each candle reads "the sales in the `window` up to then").
 */
export const SERIES_FRAMES: Record<SeriesFrame, { span: number; step: number; window: number; windowLabel: string; versus: string }> = {
  "1h": { span: HOUR, step: MINUTE, window: 10 * MINUTE, windowLabel: "10 min", versus: "vs the hour before" },
  "24h": { span: DAY, step: 10 * MINUTE, window: HOUR, windowLabel: "1 h", versus: "vs yesterday" },
  "1w": { span: 7 * DAY, step: HOUR, window: 6 * HOUR, windowLabel: "6 h", versus: "vs last week" },
  "1m": { span: 30 * DAY, step: 4 * HOUR, window: DAY, windowLabel: "24 h", versus: "vs last month" },
};

export type SalesSeries = {
  /** Dollars sold since the chart's left edge at each point (smoothed), oldest first; the last equals grossCents / 100. */
  points: { t: number; value: number }[];
  /** Candles of the trailing-window total (open, high, low, close of the rolling sum). */
  candles: VolumeCandle[];
  /** Gross over the whole span. */
  grossCents: Cents;
  /** Against the span before; null when there was nothing to compare with. */
  deltaPct: number | null;
  count: number;
};

/** Paid sales over a timeframe as a smoothed running total, with its total and change. */
export function salesSeries(payments: Payment[], frame: SeriesFrame, { mode, now = Date.now() }: { mode?: PayMode; now?: number } = {}): SalesSeries {
  const { span, step, window } = SERIES_FRAMES[frame];
  const end = Math.floor(now / step) * step + step;
  const start = end - span;
  const events = paid(payments)
    .filter((p) => !mode || p.mode === mode)
    .map((p) => ({ t: atMost(p, now), v: p.amountCents / 100, cents: p.amountCents }))
    .sort((a, b) => a.t - b.t);

  let gross = 0;
  let prev = 0;
  let count = 0;
  for (const e of events) {
    if (e.t > start && e.t <= end) {
      gross += e.cents;
      count += 1;
    } else if (e.t > start - span && e.t <= start) prev += e.cents;
  }

  // Running total since the chart's left edge: each point is what has sold so far
  // in this window, so the line ends at the headline figure. Gaussian-smoothed
  // (sigma = n/24 samples: 60 min at 24h, 2.5 min at 1h, 7 h at 1w, 30 h at 1m) so
  // each sale is a soft rise rather than a step. Monotone, so no dips are invented.
  const n = Math.round(span / step);
  const inWindow = events.filter((e) => e.t > start && e.t <= end);
  const raw: number[] = [];
  let k = 0;
  let run = 0;
  for (let i = 0; i <= n; i++) {
    const t = start + i * step;
    while (k < inWindow.length && inWindow[k]!.t <= t) run += inWindow[k++]!.v;
    raw.push(run);
  }
  const sigma = Math.max(1, n / 24);
  const r = Math.ceil(sigma * 3);
  const kern = Array.from({ length: 2 * r + 1 }, (_, j) => Math.exp(-((j - r) ** 2) / (2 * sigma * sigma)));
  const ks = kern.reduce((a, b) => a + b, 0);
  const smooth = raw.map((_, i) => kern.reduce((acc, w, j) => acc + w * raw[Math.max(0, Math.min(n, i + j - r))]!, 0) / ks);
  smooth[0] = 0;
  smooth[n] = gross / 100; // ends exactly at the headline figure
  const points = smooth.map((v, i) => ({ t: start + i * step, value: Math.round(v * 100) / 100 }));

  // Candles keep the trailing-window view (ups and downs); a running total
  // would make every candle green.
  const trailing = windowSeries(events, start, step, n, window);
  const per = Math.max(1, Math.round(trailing.length / 28));
  const candles: VolumeCandle[] = [];
  for (let i = 0; i + 1 < trailing.length; i += per) {
    const slice = trailing.slice(i, i + per + 1);
    candles.push({ t: start + i * step, o: slice[0]!, c: slice[slice.length - 1]!, h: Math.max(...slice), l: Math.min(...slice) });
  }

  return { points, candles, grossCents: gross, deltaPct: pctChange(gross, prev), count };
}

/**
 * The trailing-window total at each sample, smoothed: each sale rises and
 * falls as a causal hump (a gamma kernel that peaks `tau` after the sale and
 * integrates to `window`), so nothing comes from the future. Used for candles.
 */
function windowSeries(events: { t: number; v: number }[], start: number, step: number, n: number, window: number): number[] {
  const tau = window / 3;
  const out: number[] = [];
  let first = 0;
  for (let i = 0; i <= n; i++) {
    const t = start + i * step;
    while (first < events.length && events[first]!.t < t - 10 * tau) first++;
    let sum = 0;
    for (let j = first; j < events.length && events[j]!.t <= t; j++) {
      const x = (t - events[j]!.t) / tau;
      sum += events[j]!.v * 3 * x * Math.exp(-x);
    }
    out.push(Math.max(0, Math.round(sum * 100) / 100));
  }
  return out;
}
