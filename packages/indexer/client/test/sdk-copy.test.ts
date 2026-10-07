/**
 * src/sdk-events.ts and src/sdk-event-shape.ts are polarispay-sdk's own
 * source, copied so the business server (which transpiles this package, not
 * the SDK's build) can run the SDK's validateWebhookEvent. Below their
 * header and import lines they must be the SDK's files, byte for byte.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, ...p), "utf8").replace(/\r\n/g, "\n");

/** Everything after the last top-level `import` line, or after the inlined aliases that replaced it. */
function body(source: string, skip: RegExp): string {
  const lines = source.split("\n");
  let last = -1;
  lines.forEach((line, i) => {
    if (skip.test(line)) last = i;
  });
  return lines.slice(last + 1).join("\n").trimStart();
}

describe("the copies of polarispay-sdk's event check", () => {
  it("event-shape.ts is the SDK's, below its import", () => {
    const sdk = read("..", "..", "..", "sdk", "src", "event-shape.ts");
    const copy = read("..", "src", "sdk-event-shape.ts");
    assert.equal(body(copy, /^import /), body(sdk, /^import /));
  });

  it("events.ts is the SDK's, below its import (inlined as three type aliases)", () => {
    const sdk = read("..", "..", "..", "sdk", "src", "events.ts");
    const copy = read("..", "src", "sdk-events.ts");
    assert.match(sdk, /^import type \{ Address, CheckoutMode, Hex \} from "\.\/types\.js";$/m);
    assert.equal(body(copy, /^type (Address|Hex|CheckoutMode) = /), body(sdk, /^import /));
  });
});
