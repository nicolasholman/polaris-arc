import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The product has no offline demo: no sample book, no stub relayer with
 * made-up hashes, no placeholder EIP-712 domains. A build without
 * NEXT_PUBLIC_POLARIS_API_URL shows only that Polaris isn't configured.
 * These read the source, so a stand-in can't creep back in unnoticed.
 */

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const sources = files(src).map((path) => ({ path: relative(src, path), text: readFileSync(path, "utf8") }));
const read = (path: string) => readFileSync(join(src, path), "utf8");

describe("no offline demo in the product", () => {
  const gone = [
    /data\/mock/,
    /\bmockData\b/,
    /\bmockLedger\b/,
    /\bSAMPLE_DATA\b/,
    /\bSAMPLE_LINK_IDS\b/,
    /\bDEMO_LINK_IDS\b/,
    /\bDEMO_MODE\b/,
    /\bRELAYER_IS_STUB\b/,
    /\bstubRelayer\b/,
    /\bfakeTxHash\b/,
    /\bplaceholderDomain\b/,
    /\bPLACEHOLDER_NAMES\b/,
    /\bwithSample\b/,
    /\bsampleMemo\b/,
  ];

  for (const pattern of gone) {
    it(`nothing in src matches ${pattern}`, () => {
      const hits = sources.filter((f) => pattern.test(f.text)).map((f) => f.path);
      assert.deepEqual(hits, []);
    });
  }

  it("has one relayer, Polaris for Business's", () => {
    const relayer = read("lib/relayer.ts");
    assert.match(relayer, /export const relayer: Relayer = \{/);
    assert.doesNotMatch(relayer, /simulated/);
  });

  it("signs only under a domain Polaris for Business reports", () => {
    const domains = read("lib/domains.ts");
    assert.match(domains, /if \(!network\) return Promise\.reject\(new ApiError\(0, "not_configured"/);
    assert.doesNotMatch(domains, /readDomain/);
  });

  it("shows only the not-configured screen without the API", () => {
    assert.match(read("components/shell/providers.tsx"), /if \(!apiConfigured\(\)\) return <NotConfigured \/>;/);
    assert.match(read("components/not-configured.tsx"), /Polaris isn't configured on this build/);
  });

  it("gives every account face the account's own digits and Boost the vault's figure", () => {
    const accounts = read("components/accounts.tsx");
    assert.doesNotMatch(accounts, /last4: "/);
    assert.doesNotMatch(accounts, /balance: 0\b/);
    assert.match(accounts, /balance: n\(boost\.value\.locked\)/);
    assert.match(read("lib/data/live.ts"), /functionName: "lockedOf"/);
  });

  it("serves the component gallery in development only", () => {
    assert.match(read("app/gallery/page.tsx"), /if \(process\.env\.NODE_ENV === "production"\) notFound\(\);/);
  });
});
