/**
 * Axis ticks and their labels. Pure (no React), so they can be tested on
 * their own: `packages/ui/test/ticks.test.ts`.
 */

/**
 * Exactly `count` evenly spaced round labels whose top sits at or above the
 * highest value: the scale spans the whole line, like the reference.
 */
export function spanTicks(min: number, max: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  if (min === max) {
    if (min === 0) max = 1;
    else {
      const pad = Math.abs(min) * 0.2;
      min = Math.max(0, min - pad);
      max = max + pad;
    }
  }
  const steps = Math.max(1, count - 1);
  const rough = (max - min) / steps;
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10, 15, 20, 25, 50]) {
    const step = m * pow;
    let lo = Math.floor(min / step) * step;
    if (min >= 0 && lo < 0) lo = 0;
    const hi = lo + steps * step;
    if (hi >= max - step * 1e-9) {
      return { lo, hi, ticks: Array.from({ length: count }, (_, i) => Number((lo + i * step).toFixed(10))) };
    }
  }
  return { lo: min, hi: max, ticks: [min, max] };
}

/**
 * The fewest decimals (up to `max`) that write every tick exactly: 0 for
 * 0, 1, 2, 3; 1 for 0, 0.5, 1; 2 for 0, 0.75, 1.5, 2.25. So labels on one
 * axis share a precision and never collapse into each other ("0, 1, 2, 2").
 */
export function tickDecimals(ticks: number[], max = 4): number {
  for (let d = 0; d < max; d++) {
    const f = 10 ** d;
    if (ticks.every((t) => Math.abs(t * f - Math.round(t * f)) < 1e-6 * Math.max(1, Math.abs(t * f)))) return d;
  }
  return max;
}

/** "2.5k", "400", "1.2M": one short number. */
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  const trim = (x: number) => (Math.round(x * 10) / 10).toString();
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e3) return `${trim(v / 1e3)}k`;
  return Math.round(v).toString();
}

/**
 * Short labels for a whole axis that fit a narrow gutter: one unit for all
 * of them (k or M, from the largest), one precision for all of them, as few
 * decimals as keep them exact (two at most below a thousand, one above,
 * unless more are needed to tell them apart).
 * "0, 0.75, 1.50, 2.25", "0, 2.5k, 5.0k, 7.5k", "0, 100, 200, 300".
 * Zero is always "0".
 */
export function compactTickLabels(ticks: number[]): string[] {
  const top = Math.max(0, ...ticks.map((t) => Math.abs(t)));
  const [div, unit, cap]: [number, string, number] = top >= 1e6 ? [1e6, "M", 1] : top >= 1e3 ? [1e3, "k", 1] : [1, "", 2];
  const scaled = ticks.map((t) => t / div);
  const label = (d: number) => scaled.map((v) => (v === 0 ? "0" : `${v.toFixed(d)}${unit}`));
  // Exact within the cap; past it (a span under a cent), as many more as keep them apart.
  let d = tickDecimals(scaled, cap);
  let out = label(d);
  while (new Set(out).size < out.length && d < 4) out = label(++d);
  return out;
}
