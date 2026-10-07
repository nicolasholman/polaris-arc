import type { ActivityItem, CreditLine, Plan } from "./data";
import { toNumber } from "./money";
import { movesBalance, signed } from "./view";

/**
 * Time series for the desktop charts (ref E's line and candles), rebuilt from
 * the same reads the phone screens use. A balance moves in steps, one per
 * payment; drawn as one smooth continuous curve, each step eases in over a
 * short while before it lands (a visible wiggle per payment, never a long
 * ramp), so the line always ends exactly on today's figure.
 *
 * Nothing is drawn before the account (or the line) existed: a series
 * starts at `since` when that is inside the frame. And a figure is only
 * given a history the moves explain: when the steps since `since` don't add
 * up to today's figure (a move the app can't see), the line starts at the
 * first move it knows and the series says so (`explained: false`), so no
 * screen shows a percentage or a flat week it made up.
 */

export type Frame = "1h" | "24h" | "1w" | "1m";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const FRAMES: Record<Frame, { span: number; points: number; candle: number; suffix: string; title: string; last: string }> = {
  "1h": { span: HOUR, points: 61, candle: 5 * MIN, suffix: "this hour", title: "the last hour", last: "Now" },
  "24h": { span: DAY, points: 97, candle: HOUR, suffix: "today", title: "the last 24 hours", last: "Now" },
  "1w": { span: 7 * DAY, points: 113, candle: 6 * HOUR, suffix: "this week", title: "the last 7 days", last: "Today" },
  "1m": { span: 30 * DAY, points: 121, candle: DAY, suffix: "this month", title: "the last 30 days", last: "Today" },
};

export type SeriesPoint = { t: number; value: number };
export type SeriesCandle = { t: number; o: number; h: number; l: number; c: number };

export type Series = {
  points: SeriesPoint[];
  /** When each move in the frame landed, oldest first (where the bubble can rest). */
  moves: number[];
  candles: SeriesCandle[];
  /** The figure at the start of the frame and now (exact, not smoothed). */
  start: number;
  end: number;
  /** The change over the frame in percent; null with nothing to compare against. */
  deltaPct: number | null;
  /** Every value zero: nothing to draw. */
  empty: boolean;
  /** The moves add up to today's figure from where the series starts; false means no change is claimed. */
  explained: boolean;
};

/** A step of `delta` dollars that lands at `at`. */
type Step = { at: number; delta: number };

/** 0 before `from`, 1 after `to`, a smooth S between (smootherstep). */
function ease(t: number, from: number, to: number): number {
  if (t <= from) return 0;
  if (t >= to) return 1;
  const x = (t - from) / (to - from);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

type Origin = {
  /**
   * When the account (or the line) was opened: nothing before it is drawn.
   * null: not known (only the moves are). Left out: the whole frame, as the
   * moves draw it.
   */
  since?: number | null;
  /** The figure when it opened: 0 for a dollar account, the limit for a Pay later line. */
  base?: number;
};

/** A figure that is `end` now and moved by `steps` on the way. */
function build(end: number, allSteps: Step[], frame: Frame, now: number, origin: Origin = {}): Series {
  const { span: frameSpan, points: count, candle } = FRAMES[frame];
  const steps = allSteps.filter((s) => s.at <= now).sort((a, b) => a.at - b.at);
  const firstMove = steps[0]?.at ?? null;
  const whole = origin.since === undefined;
  const since = origin.since ?? null;
  // Do the moves explain today's figure from the opening one? Only then is there a history to draw.
  const moved = steps.reduce((s, x) => s + x.delta, 0);
  const explained = whole || (since !== null && Math.abs((origin.base ?? 0) + moved - end) < 0.005);
  const opened = whole ? null : explained && since !== null ? Math.min(since, firstMove ?? since) : firstMove;
  // Never before the account existed (at least a minute, so there is a line to draw).
  const from = Math.min(now - MIN, Math.max(now - frameSpan, opened ?? now - frameSpan));
  const span = now - from;
  // Each step eases in over about the average time between moves in the
  // frame, so the line runs on from one payment to the next (a wiggle per
  // payment, no long flat plateaus), but never more than an eighth of the
  // frame (one payment isn't smeared into a day-long slope) nor under 15
  // minutes.
  const moving = steps.filter((s) => s.at > from && s.at <= now).length;
  const full = Math.max(15 * MIN, Math.min(frameSpan / 8, frameSpan / (moving + 1)));
  // A line younger than its frame (an account opened minutes ago) is drawn over its own short span:
  // there each step takes at most an eighth of it, so $0 → $500 → $1,000 reads as steps, not a slope.
  const ramp = span < frameSpan ? Math.min(span / 8, full) : full;

  const exact = (t: number) => end - steps.filter((s) => s.at > t).reduce((sum, s) => sum + s.delta, 0);
  const smooth = (t: number) => end - steps.reduce((sum, s) => sum + s.delta * (1 - ease(t, s.at - ramp, s.at)), 0);

  const points: SeriesPoint[] = Array.from({ length: count }, (_, i) => {
    const t = from + (i / (count - 1)) * span;
    return { t, value: Math.max(0, round2(smooth(t))) };
  });
  // The last point is today's figure to the cent.
  points[points.length - 1] = { t: now, value: round2(end) };

  const candles: SeriesCandle[] = [];
  for (let t0 = from; t0 < now - 1; t0 += candle) {
    const t1 = Math.min(now, t0 + candle);
    const o = exact(t0);
    const c = exact(t1);
    let h = Math.max(o, c);
    let l = Math.min(o, c);
    for (const s of steps) {
      if (s.at <= t0 || s.at > t1) continue;
      const v = exact(s.at);
      h = Math.max(h, v);
      l = Math.min(l, v);
    }
    candles.push({ t: t1, o: round2(o), h: round2(h), l: round2(l), c: round2(c) });
  }

  const start = exact(from);
  return {
    points,
    moves: steps.filter((s) => s.at > from && s.at <= now && s.delta !== 0).map((s) => s.at).sort((a, b) => a - b),
    candles,
    start: round2(start),
    end: round2(end),
    deltaPct: explained && start > 0.005 ? ((end - start) / start) * 100 : null,
    empty: points.every((p) => p.value === 0),
    explained,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Where a chart's bubble rests: on the latest move that landed inside the
 * plot (between 15% and 85% of the width), like the reference's "550.24",
 * never pinned to an edge. A line that never moved rests on its last point.
 */
export function restIndex(series: Series): number | null {
  const pts = series.points;
  const n = pts.length;
  if (n < 2) return null;
  if (pts.every((p) => p.value === pts[0]!.value)) return n - 1;
  const t0 = pts[0]!.t;
  const span = pts[n - 1]!.t - t0 || 1;
  const lo = Math.round((n - 1) * 0.15);
  const hi = Math.round((n - 1) * 0.85);
  for (let i = series.moves.length - 1; i >= 0; i--) {
    // The first point at or after the move, so the bubble shows where it landed.
    const k = Math.min(n - 1, Math.ceil(((series.moves[i]! - t0) / span) * (n - 1)));
    if (k >= lo && k <= hi) return k;
  }
  return hi;
}

/** The dollar account's balance over the frame, from zero when the account was opened (`since`). */
export function balanceSeries(balance: number, activity: ActivityItem[], frame: Frame, now: number, since?: number | null): Series {
  const steps = activity.filter((a) => movesBalance(a) && a.at <= now).map((a) => ({ at: a.at, delta: signed(a) }));
  return build(balance, steps, frame, now, { since, base: 0 });
}

/**
 * What the Pay later line can spend over the frame: a plan takes its total
 * when it opens and hands each instalment back as it is paid.
 */
export function creditSeries(credit: CreditLine, plans: Plan[], frame: Frame, now: number): Series {
  if (credit.limit === 0n && credit.openedAt !== undefined) return build(0, [], frame, now, { since: now, base: 0 });
  const steps: Step[] = [];
  for (const plan of plans) {
    const total = toNumber(plan.instalments.reduce((s, i) => s + i.amount, 0n));
    if (plan.openedAt <= now) steps.push({ at: plan.openedAt, delta: -total });
    for (const i of plan.instalments) if (i.paidAt !== null && i.paidAt <= now) steps.push({ at: i.paidAt, delta: toNumber(i.amount) });
  }
  // The line starts full when it opened (the CRE decision); before that there was no line to draw.
  return build(toNumber(credit.available), steps, frame, now, { since: credit.openedAt, base: toNumber(credit.limit) });
}

/**
 * Boost: what is locked in the vault now. The app reads the figure, not the
 * vault's history, so it claims none: nothing locked is the empty chart, and
 * dollars locked are today's figure alone, with no change over the frame.
 */
export function boostSeries(locked: number, frame: Frame, now: number): Series {
  if (locked < 0.005) return build(0, [], frame, now, { since: now - FRAMES[frame].span, base: 0 });
  return { ...build(locked, [], frame, now, { since: now, base: locked }), deltaPct: null, explained: false };
}

/** Money out per bucket over the frame, as a smooth line (Insights). */
export function spendingSeries(activity: ActivityItem[], days: number, now: number): { points: SeriesPoint[]; total: number } {
  const span = days * DAY;
  const from = now - span;
  const out = activity.filter((a) => a.direction === "out" && movesBalance(a) && a.at > from && a.at <= now);
  const total = out.reduce((s, a) => s + toNumber(a.amount), 0);
  // Spent so far in the period: a running total that eases up at each payment.
  const ramp = span / 14;
  const count = Math.min(121, days * 8 + 1);
  const points = Array.from({ length: count }, (_, i) => {
    const t = from + (i / (count - 1)) * span;
    const v = out.reduce((s, a) => s + toNumber(a.amount) * ease(t, a.at - ramp, a.at), 0);
    return { t, value: round2(v) };
  });
  points[points.length - 1] = { t: now, value: round2(total) };
  return { points, total };
}

/** Money freed on the Pay later line over the last `days`: instalments paid back. */
export function creditFreed(plans: Plan[], days: number, now: number): number {
  return plans.reduce(
    (sum, p) => sum + p.instalments.filter((i) => i.paidAt !== null && now - i.paidAt <= days * DAY && i.paidAt <= now).reduce((s, i) => s + toNumber(i.amount), 0),
    0,
  );
}
