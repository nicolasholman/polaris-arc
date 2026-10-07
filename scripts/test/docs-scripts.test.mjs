// Tests for the submission kit's two scripts: node --test scripts/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANSWER_LIMIT,
  anchorsOf,
  answersOf,
  hexRefsOf,
  inEvidence,
  isExternal,
  linksOf,
  repoUrlsOf,
  shortLinkMismatches,
  slug,
} from "../check-docs-links.mjs";
import { folderOf, summarise, toMarkdown } from "../submission-diffstat.mjs";

test("slug follows GitHub's heading anchors", () => {
  assert.equal(slug("Chainlink CRE: an orchestration layer"), "chainlink-cre-an-orchestration-layer");
  assert.equal(slug("CRE runs on Monad testnet (28 Sep 2026)"), "cre-runs-on-monad-testnet-28-sep-2026");
  assert.equal(slug("`polaris-collections`"), "polaris-collections");
  assert.equal(slug("Monad (Track 02: consumer products and payments)"), "monad-track-02-consumer-products-and-payments");
  assert.equal(slug("Agora · AUSD, across borders"), "agora--ausd-across-borders");
  assert.equal(slug("What's next"), "whats-next");
  assert.equal(slug("[Linked](x.md) **bold** heading"), "linked-bold-heading");
});

test("anchorsOf numbers repeated headings and skips fenced code", () => {
  const md = ["# Title", "## Evidence", "```", "## Not a heading", "```", "## Evidence", '<a id="custom"></a>'].join("\n");
  const anchors = anchorsOf(md);
  assert.ok(anchors.has("title"));
  assert.ok(anchors.has("evidence"));
  assert.ok(anchors.has("evidence-1"));
  assert.ok(anchors.has("custom"));
  assert.ok(!anchors.has("not-a-heading"));
});

test("linksOf finds inline, image, angle-bracket, reference and HTML links, not code", () => {
  const md = [
    "See [the plan](docs/plan.md#3-sponsor-strategy) and ![a shot](docs/demo/a.png).",
    "The login view: [here](<apps/business/src/app/(privy)/login/login-view.tsx>).",
    "A path with parentheses: [x](a/(b)/c.md)",
    "Not a link: `[x](nope.md)`",
    "```",
    "[y](also-nope.md)",
    "```",
    "[ref]: docs/submission/writeup.md",
    '<img src="docs/screenshots/x.jpg" alt="x">',
    "[site](https://monad.xyz)",
  ].join("\n");
  assert.deepEqual(
    linksOf(md).map((l) => l.target),
    [
      "docs/plan.md#3-sponsor-strategy",
      "docs/demo/a.png",
      "apps/business/src/app/(privy)/login/login-view.tsx",
      "a/(b)/c.md",
      "docs/submission/writeup.md",
      "docs/screenshots/x.jpg",
      "https://monad.xyz",
    ],
  );
  assert.equal(isExternal("https://monad.xyz"), true);
  assert.equal(isExternal("mailto:a@b.c"), true);
  assert.equal(isExternal("docs/plan.md"), false);
});

test("hexRefsOf and inEvidence: full and shortened hashes and addresses", () => {
  const hash = "0x1116fbb4b53263776da4c5cc6d7984b66f1d31ac81f35215b5dcf246f1292c4d";
  const address = "0x4201C0837f3bB4e0E1A982C5666BF00b5EE145CC";
  const known = new Set([hash, address.toLowerCase()]);
  const refs = hexRefsOf(`tx ${hash}\naddr ${address}\nshort 0x1116fbb4…292c4d and 0x4201…45CC\nname 0x38323961376630323863`);
  assert.deepEqual(
    refs.map((r) => [r.line, r.kind]),
    [
      [1, "hash"],
      [2, "address"],
      [3, "short"],
      [3, "short"],
    ],
  );
  for (const r of refs) assert.equal(inEvidence(r.value, known), true, r.value);
  assert.equal(inEvidence("0x1116fbb4…000000", known), false);
  assert.equal(inEvidence(`0x${"ab".repeat(32)}`, known), false);
});

test("shortLinkMismatches catches a shortened hash that is not its own link's", () => {
  const full = "0xef12c0718ccb1fb7f2552d143e8de507f568a4646627c892caeff017be70854c";
  const good = "[`0xef12c071…70854c`](https://testnet.monadscan.com/tx/" + full + ")";
  const bad = "[`0xef12c071…68a4c`](https://testnet.monadscan.com/tx/" + full + ")";
  assert.deepEqual(shortLinkMismatches(good), []);
  assert.deepEqual(shortLinkMismatches("x\n" + bad), [{ line: 2, short: "0xef12c071…68a4c", full }]);
  const address = "[`0x4201…45CC`](https://testnet.monadscan.com/address/0x4201C0837f3bB4e0E1A982C5666BF00b5EE145CC)";
  assert.deepEqual(shortLinkMismatches(address), []);
});

test("repoUrlsOf finds this repository's file URLs, in code blocks too", () => {
  const base = "https://github.com/nickthelegend/polaris-monad";
  const text = [
    "See https://github.com/nickthelegend/polaris-monad/blob/main/workflows/README.md#simulate.",
    "```text",
    "Code: https://github.com/nickthelegend/polaris-monad/tree/main/packages/indexer",
    "```",
    "Not ours: https://github.com/someone/else/blob/main/README.md",
    "The repository itself: https://github.com/nickthelegend/polaris-monad",
  ].join("\n");
  assert.deepEqual(repoUrlsOf(text, base), [
    { line: 1, target: "workflows/README.md#simulate" },
    { line: 3, target: "packages/indexer" },
  ]);
  assert.deepEqual(repoUrlsOf(text, null), []);
});

test("answersOf measures each fenced text block", () => {
  const long = "x".repeat(ANSWER_LIMIT + 1);
  const md = ["# Q", "```text", "short answer", "```", "```bash", "not an answer", "```", "```text", long, "```"].join("\n");
  assert.deepEqual(answersOf(md), [
    { line: 2, length: 12 },
    { line: 8, length: ANSWER_LIMIT + 1 },
  ]);
});

test("folderOf groups apps and packages by name", () => {
  assert.equal(folderOf("apps/app/src/page.tsx"), "apps/app");
  assert.equal(folderOf("packages/contracts/contracts/PolarisSend.sol"), "packages/contracts");
  assert.equal(folderOf("workflows/src/guardian/workflow.ts"), "workflows");
  assert.equal(folderOf("README.md"), "(root files)");
});

test("summarise sums numstat by folder, binary files counted apart", () => {
  const numstat = ["10\t2\tapps/app/a.ts", "5\t0\tapps/app/b.ts", "-\t-\tdocs/demo/x.png", "7\t1\tREADME.md", ""].join("\n");
  const { rows, total } = summarise(numstat);
  assert.deepEqual(
    rows.map((r) => [r.folder, r.files, r.binary, r.insertions, r.deletions]),
    [
      ["apps/app", 2, 0, 15, 2],
      ["(root files)", 1, 0, 7, 1],
      ["docs", 1, 1, 0, 0],
    ],
  );
  assert.deepEqual([total.files, total.binary, total.insertions, total.deletions], [4, 1, 22, 3]);
  assert.match(toMarkdown({ rows, total }), /\| \*\*Total\*\* \| 4 \| 1 \| 22 \| 3 \|/);
});
