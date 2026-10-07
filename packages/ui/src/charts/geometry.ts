"use client";

import { useEffect, useRef, useState } from "react";

export type Pt = [number, number];

/** Straight segments. */
export function linePath(points: Pt[]): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join("");
}

/**
 * A monotone cubic through the points (Fritsch–Carlson): smooth, with no
 * overshoot above a peak or below a trough, which matters for money.
 */
export function smoothPath(points: Pt[]): string {
  const n = points.length;
  if (n < 3) return linePath(points);
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = points[i + 1]![0] - points[i]![0];
    dx.push(h);
    slope.push(h === 0 ? 0 : (points[i + 1]![1] - points[i]![1]) / h);
  }
  const m: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    if (a * b <= 0) m.push(0);
    else {
      const w1 = 2 * dx[i]! + dx[i - 1]!;
      const w2 = dx[i]! + 2 * dx[i - 1]!;
      m.push((w1 + w2) / (w1 / a + w2 / b));
    }
  }
  m.push(slope[n - 2]!);
  let d = `M${points[0]![0].toFixed(2)} ${points[0]![1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${(x0 + h).toFixed(2)} ${(y0 + m[i]! * h).toFixed(2)} ${(x1 - h).toFixed(2)} ${(y1 - m[i + 1]! * h).toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return d;
}

/** Map values into a box: x evenly spread, y inverted (SVG grows down). */
export function project(
  values: number[],
  { width, height, top = 0, bottom = 0, left = 0, right = 0, min, max }: {
    width: number;
    height: number;
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    min?: number;
    max?: number;
  },
): { points: Pt[]; y: (v: number) => number; min: number; max: number } {
  let lo = min ?? Math.min(...values);
  let hi = max ?? Math.max(...values);
  // A flat series (one score, an unchanged balance) runs through the middle, not along the floor.
  if (hi === lo) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const y = (v: number) => top + innerH - ((v - lo) / span) * innerH;
  const points = values.map((v, i): Pt => [left + (values.length === 1 ? innerW / 2 : (i / (values.length - 1)) * innerW), y(v)]);
  return { points, y, min: lo, max: hi };
}

/** Round axis ticks ("nice numbers") covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const rough = span / Math.max(1, count - 1);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Point on a circle, 0 rad at 12 o'clock, clockwise. */
export function polar(cx: number, cy: number, r: number, angle: number): Pt {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

/** An SVG arc path from a0 to a1 (radians, clockwise from 12 o'clock). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0.toFixed(3)} ${y0.toFixed(3)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
}

/** Track an element's content-box size. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.abs(s.width - r.width) < 0.5 && Math.abs(s.height - r.height) < 0.5 ? s : { width: r.width, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Values from `number[]` or `{ value }[]`. */
export function valuesOf(data: number[] | { value: number }[]): number[] {
  return data.map((d) => (typeof d === "number" ? d : d.value));
}

const MIN = 60_000;
const HR = 60 * MIN;
const DY = 24 * HR;
/** Round steps for time labels, smallest first. */
const TIME_STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HR, 2 * HR, 3 * HR, 4 * HR, 6 * HR, 8 * HR, 12 * HR, DY, 2 * DY, 7 * DY, 14 * DY];

/**
 * Round times between `t0` and `t1` (ms) for at most `room` labels: whole
 * minutes and hours, or midnights for days, on the viewer's clock (or UTC).
 * The charts' x axes ("2:00 AM", "6:00 AM"…, like the reference).
 */
export function roundTimes(t0: number, t1: number, room: number, zone: "local" | "utc" = "local"): number[] {
  if (!(t1 > t0)) return [];
  const span = t1 - t0;
  const step = TIME_STEPS.find((s) => Math.floor(span / s) <= room) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const offset = zone === "utc" ? 0 : new Date(t0).getTimezoneOffset() * MIN;
  const first = Math.ceil((t0 - offset) / step) * step + offset;
  const out: number[] = [];
  for (let t = first; t <= t1; t += step) out.push(t);
  return out;
}
