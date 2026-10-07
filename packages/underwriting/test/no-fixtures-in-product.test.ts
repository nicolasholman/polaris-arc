/**
 * Zero mocks in the running product: the fixture files and the transports
 * that answer from them are test doubles. No product source may reach them,
 * so a provider without its key is "not configured", never answered from a
 * file. This holds the package and every product path that runs
 * underwriting (the gateway, the API, the app, the CRE workflow and its local
 * runner) to that.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const REPO = join(PKG, "..", "..");

/** Product sources: everything that runs outside a test. */
const PRODUCT_DIRS = [
  join(PKG, "src", "core"),
  join(PKG, "src", "node"),
  join(PKG, "src", "client"),
  join(REPO, "apps", "gateway", "src"),
  join(REPO, "apps", "business", "src"),
  join(REPO, "apps", "app", "src"),
  join(REPO, "workflows", "src"),
  join(REPO, "workflows", "local"),
  join(REPO, "workflows", "scripts"),
];

const REACHES_FIXTURES: Array<[RegExp, string]> = [
  [/@polarispay\/underwriting\/testing/, "imports the test doubles entry"],
  [/underwriting\/(src\/)?testing\//, "imports the test doubles by path"],
  [/\bfixture(Transport|Response)\b|\bDEFAULT_FIXTURES_DIR\b|\blocateFixture\b/, "uses the fixture transport"],
  [/packages\/underwriting\/fixtures|underwriting["', ]+fixtures/, "reads the fixture files"],
  [/test\/helpers\/fixtures-http/, "uses the workflows' fixture HTTP test helper"],
  [/\bUNDERWRITING_MODE\b\s*[:=]+\s*["']?fixture/, "asks for fixture mode"],
];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mjs|cjs|js)$/.test(p) ? [p] : [];
  });
}

/** Source without comments, so a doc comment may say what the code must not do. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("no fixture evidence in the product", () => {
  it("no product source reaches the fixtures or their transports", () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const dir of PRODUCT_DIRS) {
      for (const file of files(dir)) {
        scanned++;
        const src = code(file);
        for (const [pattern, why] of REACHES_FIXTURES) {
          if (pattern.test(src)) hits.push(`${relative(REPO, file)}: ${why}`);
        }
      }
    }
    assert.ok(scanned > 50, `scanned ${scanned} files: the product directories moved?`);
    assert.deepEqual(hits, []);
  });

  it("the package's main entry exports no fixture transport", async () => {
    const main = await import("../src/node/index.ts");
    for (const name of ["fixtureTransport", "fixtureResponse", "locateFixture", "DEFAULT_FIXTURES_DIR"]) {
      assert.equal(name in main, false, `${name} is exported from @polarispay/underwriting`);
    }
  });
});
