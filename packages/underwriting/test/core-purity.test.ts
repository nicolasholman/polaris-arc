/**
 * The core runs inside the CRE workflow, compiled to WASM, where Node APIs do
 * not exist and every node must compute the same bytes. tsconfig.core.json
 * enforces the first at compile time; this test also catches the
 * nondeterministic calls that do typecheck (Date.now, Math.random) and any
 * import that reaches outside the core.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("../src/core/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Source without comments, so a doc comment may mention what the code must not do. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bDate\.now\s*\(/, "Date.now(): nodes disagree; take observedAt from the caller"],
  [/\bnew Date\s*\(\s*\)/, "new Date(): the machine's clock"],
  [/\bMath\.random\s*\(/, "Math.random(): nondeterministic"],
  [/\bprocess\./, "process: Node-only"],
  [/\bBuffer\b/, "Buffer: Node-only"],
  [/\brequire\s*\(/, "require: Node-only"],
  [/\bfetch\s*\(/, "fetch: the core does no I/O"],
  [/\bset(Timeout|Interval)\s*\(/, "timers: the core does no I/O"],
  [/\bIntl\b|toLocale\w*String/, "Intl: may be missing under QuickJS, and locale-dependent"],
  [/\bText(En|De)coder\b/, "TextEncoder: not in every WASM runtime"],
  [/\batob\s*\(|\bbtoa\s*\(/, "atob/btoa: use base64Ascii"],
];

describe("the core is pure", () => {
  const sources = files(CORE);

  it("has sources to check", () => {
    assert.ok(sources.length >= 10);
  });

  for (const path of sources) {
    const rel = relative(CORE, path);
    it(`${rel} uses no clock, randomness, I/O or Node API`, () => {
      const src = code(path);
      for (const [re, why] of FORBIDDEN) assert.doesNotMatch(src, re, `${rel}: ${why}`);
    });

    it(`${rel} imports only from the core`, () => {
      for (const m of readFileSync(path, "utf8").matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = m[1]!;
        assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${rel} imports package ${spec}`);
        const target = join(path, "..", spec);
        assert.ok(!relative(CORE, target).startsWith(".."), `${rel} reaches outside the core: ${spec}`);
      }
    });
  }
});
