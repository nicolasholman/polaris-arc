import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placeMenu } from "../src/primitives/menu-position.ts";

/**
 * R1 B6: a table row's "…" menu was absolutely positioned inside the table's
 * `overflow-x-auto` box and clipped. The menu is now portalled to <body> and
 * placed in viewport coordinates from the trigger's rect.
 */

const viewport = { width: 1280, height: 800 };
const trigger = (top: number, left: number, size = 40) => ({ top, bottom: top + size, left, right: left + size });

describe("placeMenu", () => {
  it("opens under the trigger, lined up with its end edge", () => {
    const p = placeMenu({ trigger: trigger(380, 1000), menuHeight: 120, width: 240, align: "end", side: "bottom", viewport });
    assert.deepEqual(p, { left: 1040 - 240, top: 428, width: 240, above: false, theme: null });
  });

  it("lines up with the start edge for align=start", () => {
    const p = placeMenu({ trigger: trigger(100, 300), menuHeight: 120, width: 240, align: "start", side: "bottom", viewport });
    assert.equal(p.left, 300);
  });

  it("flips above when there isn't room below and there is above", () => {
    const p = placeMenu({ trigger: trigger(720, 1000), menuHeight: 160, width: 240, align: "end", side: "bottom", viewport });
    assert.equal(p.above, true);
    assert.equal(p.top, 712); // the menu's bottom edge, 8 px over the trigger
  });

  it("keeps side=top unless only below has room", () => {
    assert.equal(placeMenu({ trigger: trigger(400, 500), menuHeight: 160, width: 240, align: "end", side: "top", viewport }).above, true);
    assert.equal(placeMenu({ trigger: trigger(30, 500), menuHeight: 160, width: 240, align: "end", side: "top", viewport }).above, false);
  });

  it("stays inside the viewport: clamped at the edges, narrowed on a phone", () => {
    const phone = { width: 375, height: 812 };
    const left = placeMenu({ trigger: trigger(200, 4), menuHeight: 100, width: 280, align: "end", side: "bottom", viewport: phone });
    assert.equal(left.left, 12);
    const wide = placeMenu({ trigger: trigger(200, 300), menuHeight: 100, width: 420, align: "start", side: "bottom", viewport: phone });
    assert.equal(wide.width, 375 - 24);
    assert.equal(wide.left, 12);
  });

  it("carries the trigger's theme to the portalled menu", () => {
    assert.equal(placeMenu({ trigger: trigger(10, 10), menuHeight: 10, width: 100, align: "start", side: "bottom", viewport, theme: "light" }).theme, "light");
  });
});
