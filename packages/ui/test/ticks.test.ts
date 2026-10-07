import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compactTickLabels, spanTicks, tickDecimals } from "../src/charts/ticks.ts";

/**
 * R1 B11: at 375 px the Overview's chart went compact and its y axis read
 * "0, 1, 2, 2" (ticks 0, 0.75, 1.5, 2.25 each rounded to a whole dollar).
 * Labels for one axis are now made together: distinct, one precision.
 */

const distinct = (labels: string[]) => new Set(labels).size === labels.length;

describe("spanTicks", () => {
  it("spans the values with `count` evenly spaced round ticks", () => {
    const { lo, hi, ticks } = spanTicks(0, 2, 4);
    assert.equal(ticks.length, 4);
    assert.equal(lo, 0);
    assert.ok(hi >= 2);
    const steps = ticks.slice(1).map((t, i) => Number((t - ticks[i]!).toFixed(10)));
    assert.ok(steps.every((s) => s === steps[0]), `even steps: ${steps}`);
  });

  it("never draws a negative tick for non-negative values, and handles a flat zero line", () => {
    assert.ok(spanTicks(0.3, 9.7, 4).ticks.every((t) => t >= 0));
    assert.deepEqual(spanTicks(0, 0, 4).ticks.length, 4);
  });
});

describe("tickDecimals", () => {
  it("is the fewest decimals that write every tick exactly", () => {
    assert.equal(tickDecimals([0, 1, 2, 3]), 0);
    assert.equal(tickDecimals([0, 0.5, 1, 1.5]), 1);
    assert.equal(tickDecimals([0, 0.75, 1.5, 2.25]), 2);
    assert.equal(tickDecimals([0, 0.1 + 0.2, 0.6]), 1);
    assert.equal(tickDecimals([0, 0.0001], 2), 2);
  });
});

describe("compactTickLabels", () => {
  it("labels the R1 axis (0 to $2.25) without repeats: 0, 0.75, 1.50, 2.25", () => {
    const { ticks } = spanTicks(0, 2, 4);
    const labels = compactTickLabels(ticks);
    assert.deepEqual(labels, ["0", "0.75", "1.50", "2.25"]);
  });

  it("keeps whole numbers whole, and shares one unit and precision above a thousand", () => {
    assert.deepEqual(compactTickLabels([0, 100, 200, 300]), ["0", "100", "200", "300"]);
    assert.deepEqual(compactTickLabels([0, 2500, 5000, 7500]), ["0", "2.5k", "5.0k", "7.5k"]);
    assert.deepEqual(compactTickLabels([0, 1_000_000, 2_000_000]), ["0", "1M", "2M"]);
  });

  it("gives distinct labels for every span spanTicks makes, small to large", () => {
    for (const max of [0.01, 0.4, 1, 1.99, 2, 2.25, 3.3, 7, 9.99, 12.5, 49, 101, 999, 1234, 9_999, 45_000, 1_234_567]) {
      const { ticks } = spanTicks(0, max, 4);
      const labels = compactTickLabels(ticks);
      assert.ok(distinct(labels), `${max}: ${labels.join(", ")}`);
      for (const l of labels) assert.ok(l.length <= 5, `${max}: "${l}" fits the 48 px compact axis`);
    }
  });
});
