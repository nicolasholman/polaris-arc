import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Hex } from "viem";

import { INTENT_STATUS, pendingIds } from "../src/ccip.ts";

describe("cross-chain intents", () => {
  it("tries only intents still pending, in the order they arrived", () => {
    const a = `0x${"a".repeat(64)}` as Hex;
    const b = `0x${"b".repeat(64)}` as Hex;
    const c = `0x${"c".repeat(64)}` as Hex;
    const seen = new Map<Hex, number>([
      [a, INTENT_STATUS.PENDING],
      [b, INTENT_STATUS.SETTLED],
      [c, INTENT_STATUS.PENDING],
    ]);
    assert.deepEqual(pendingIds(seen), [a, c]);
    seen.set(a, INTENT_STATUS.REFUNDED);
    assert.deepEqual(pendingIds(seen), [c]);
  });
});
