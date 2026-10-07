#!/usr/bin/env node
/**
 * Checks the links and on-chain references in the submission kit and the
 * root README, so nothing a judge clicks is broken and no hash is made up.
 *
 *   node scripts/check-docs-links.mjs            # README.md and docs/submission/*.md
 *   node scripts/check-docs-links.mjs a.md b.md  # those files instead
 *
 * For every Markdown file:
 *  1. Every relative link ([text](path), ![alt](path), <a href>, <img src>,
 *     reference definitions) names a file or folder that git would publish:
 *     tracked, or new and not ignored. A file that only exists on this
 *     machine (.env, .demo/, build output) fails, because it will 404 on
 *     GitHub.
 *  2. Every #fragment names a heading (GitHub's slug) or an HTML id/name in
 *     the target Markdown file.
 *
 * For every file under docs/submission/ (the kit), also:
 *  3. Every full transaction hash (0x + 64 hex) and address (0x + 40 hex)
 *     appears in the committed evidence (EVIDENCE below: the deployment
 *     records and source verification, the live testnet runs through Privy,
 *     the CRE runs, the workflows' configs), and every shortened
 *     one ("0x1116fbb4…292c4d", "0x4201…45CC") matches one that does.
 *  4. Every fenced ```text block (a paste-ready portal answer) is at most
 *     4,000 characters, the portal's limit.
 *
 * And in every file: a full GitHub URL into this repository (the origin
 * remote, …/blob/<ref>/<path>) is checked like a relative link from the
 * repository root, code blocks included; and a link whose text is a
 * shortened hash or address
 * ([`0x1116fbb4…292c4d`](https://…/tx/0x1116…)) must shorten the one in its
 * own URL.
 *
 * External links (https:, mailto:) are counted, not fetched. Exit code 1 on
 * any failure, each listed as file:line.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The committed, machine-written records a hash or address in the kit must come from. */
export const EVIDENCE = [
  "packages/contracts/deployments/monad-testnet.json",
  "packages/contracts/deployments/monad-testnet.transactions.json",
  "packages/contracts/deployments/monad-testnet.smoke.json",
  "packages/contracts/deployments/monad-testnet.deploy.txt",
  "packages/contracts/deployments/monad-testnet.redeploy-guardian.txt",
  "packages/contracts/deployments/monad-testnet.redeploy-vault.txt",
  "packages/contracts/deployments/monad-testnet.grant-relayer.txt",
  "packages/contracts/deployments/monad-testnet.transfer-registry-owner.txt",
  "packages/contracts/deployments/monad-testnet.check.txt",
  "packages/contracts/deployments/monad-testnet.verification.json",
  "docs/demo/testnet",
  "workflows/evidence",
  "workflows/collections",
  "workflows/underwriting",
  "workflows/guardian",
  "packages/fx/src",
  "docs/demo/chainlink/results.json",
];

/**
 * GitHub's heading anchor: lower case; drop what is neither a letter, a mark,
 * a number, a space, "-" nor "_"; spaces become "-". Inline Markdown is
 * reduced to its text first.
 * @param {string} heading the heading text, without the leading #s
 * @returns {string}
 */
export function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`/g, "")
    .replace(/\*\*|__|\*/g, "")
    .trim();
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Every anchor a Markdown file offers: heading slugs (with GitHub's -1, -2
 * for repeats) and HTML id/name attributes.
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function anchorsOf(markdown) {
  const anchors = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      anchors.add(n === 0 ? base : `${base}-${n}`);
      seen.set(base, n + 1);
    }
    for (const m of line.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
  }
  return anchors;
}

/**
 * The destination after "](", as Markdown reads it: "<...>" or up to the
 * first space or unbalanced ")".
 * @param {string} s the text right after "]("
 * @returns {string | null}
 */
function destination(s) {
  const t = s.replace(/^\s+/, "");
  if (t.startsWith("<")) {
    const end = t.indexOf(">");
    return end < 0 ? null : t.slice(1, end);
  }
  let depth = 0;
  let i = 0;
  for (; i < t.length; i++) {
    const c = t[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (/\s/.test(c)) break;
  }
  return i === 0 ? null : t.slice(0, i);
}

/**
 * Every link in a Markdown file, outside fenced code and inline code.
 * @param {string} markdown
 * @returns {{ line: number, target: string }[]}
 */
export function linksOf(markdown) {
  const out = [];
  let fence = null;
  markdown.split(/\r?\n/).forEach((raw, index) => {
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const line = raw.replace(/(`+)(.+?)\1/g, (m) => " ".repeat(m.length));
    const at = index + 1;
    let from = 0;
    for (;;) {
      const i = line.indexOf("](", from);
      if (i < 0) break;
      const target = destination(line.slice(i + 2));
      if (target !== null) out.push({ line: at, target });
      from = i + 2;
    }
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (ref) out.push({ line: at, target: ref[1].replace(/^<|>$/g, "") });
    for (const m of line.matchAll(/<(?:a|img|source|video)\s[^>]*\b(?:href|src)="([^"]+)"/g)) out.push({ line: at, target: m[1] });
  });
  return out;
}

/** @param {string} target */
export const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");

/**
 * Every hash and address a file names, full or shortened with "…".
 * @param {string} text
 * @returns {{ line: number, value: string, kind: "hash" | "address" | "short" }[]}
 */
export function hexRefsOf(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const m of line.matchAll(/0x[0-9a-fA-F]+(?:…[0-9a-fA-F]*)?/g)) {
      const value = m[0];
      const hex = value.slice(2);
      if (value.includes("…")) {
        if (/^[0-9a-fA-F]{4,}…[0-9a-fA-F]*$/.test(hex)) out.push({ line: index + 1, value, kind: "short" });
      } else if (hex.length === 64) out.push({ line: index + 1, value, kind: "hash" });
      else if (hex.length === 40) out.push({ line: index + 1, value, kind: "address" });
    }
  });
  return out;
}

/**
 * Whether a hash or address (full or shortened) is in the evidence.
 * @param {string} value
 * @param {Set<string>} known every full hash and address in the evidence, lower case
 * @returns {boolean}
 */
export function inEvidence(value, known) {
  const v = value.toLowerCase();
  if (!v.includes("…")) return known.has(v);
  const [prefix, suffix] = v.split("…");
  for (const k of known) if (k.startsWith(prefix) && k.endsWith(suffix)) return true;
  return false;
}

/**
 * Links whose text is a shortened hash or address ("0x1116fbb4…292c4d") that
 * does not match the full one in the link's own URL.
 * @param {string} text
 * @returns {{ line: number, short: string, full: string }[]}
 */
export function shortLinkMismatches(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const m of line.matchAll(/\[`?(0x[0-9a-fA-F]+)…([0-9a-fA-F]*)`?\]\([^)\s]*?(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})[^)]*\)/g)) {
      const [, prefix, suffix, full] = m;
      const f = full.toLowerCase();
      if (!f.startsWith(prefix.toLowerCase()) || !f.endsWith(suffix.toLowerCase())) {
        out.push({ line: index + 1, short: `${prefix}…${suffix}`, full });
      }
    }
  });
  return out;
}

/**
 * Full GitHub URLs into this repository (…/blob/<ref>/<path>, …/tree/<ref>/<path>)
 * anywhere in the text, code blocks included: the paste-ready answers carry
 * them, and they must name files that exist.
 * @param {string} text
 * @param {string | null} base e.g. "https://github.com/owner/repo"
 * @returns {{ line: number, target: string }[]} target: the repository-relative path, with any #fragment
 */
export function repoUrlsOf(text, base) {
  const out = [];
  if (!base) return out;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}/(?:blob|tree)/[^/\\s)]+/([^\\s)\`"'<>]+)`, "gi");
  text.split(/\r?\n/).forEach((line, index) => {
    for (const m of line.matchAll(re)) out.push({ line: index + 1, target: m[1].replace(/[.,;:]+$/, "") });
  });
  return out;
}

/** The portal's limit for one bounty answer (docs/submission/sources.md, "The portal"). */
export const ANSWER_LIMIT = 4000;

/**
 * Every fenced ```text block (a paste-ready answer) and its length.
 * @param {string} markdown
 * @returns {{ line: number, length: number }[]}
 */
export function answersOf(markdown) {
  const out = [];
  let open = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (open === null) {
      if (/^\s*```text\s*$/.test(line)) open = { line: index + 1, lines: [] };
    } else if (/^\s*```\s*$/.test(line)) {
      out.push({ line: open.line, length: open.lines.join("\n").length });
      open = null;
    } else open.lines.push(line);
  });
  return out;
}

/** This repository on GitHub, from the origin remote, or null. */
function githubBase() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    return m ? `https://github.com/${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/** @param {string} p a repository-relative path */
const toPosix = (p) => p.split(sep).join("/");

/** Files git would publish: tracked, or untracked and not ignored. */
function publishable() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Set(out.split("\0").filter(Boolean).filter((f) => existsSync(join(REPO, f))));
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return { files, dirs };
}

/** Every full hash and address in the evidence, lower case. */
function evidenceSet() {
  const known = new Set();
  const read = (abs) => {
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) read(join(abs, name));
      return;
    }
    if (!/\.(json|txt|log|md|ts|mjs|js|yaml|yml)$/.test(abs)) return;
    for (const m of readFileSync(abs, "utf8").matchAll(/0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) known.add(m[0].toLowerCase());
  };
  for (const p of EVIDENCE) {
    const abs = join(REPO, p);
    if (existsSync(abs)) read(abs);
  }
  return known;
}

function defaultFiles() {
  const kit = join(REPO, "docs", "submission");
  const files = [join(REPO, "README.md")];
  if (existsSync(kit)) for (const name of readdirSync(kit).sort()) if (name.endsWith(".md")) files.push(join(kit, name));
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => resolve(a)) : defaultFiles();
  const { files: published, dirs } = publishable();
  const known = evidenceSet();
  const anchorCache = new Map();
  const anchorsFor = (abs) => {
    if (!anchorCache.has(abs)) anchorCache.set(abs, anchorsOf(readFileSync(abs, "utf8")));
    return anchorCache.get(abs);
  };

  const base = githubBase();
  const failures = [];
  let checked = 0;
  let external = 0;
  let refs = 0;
  let urls = 0;
  let answers = 0;

  /**
   * One link: the file or folder must be published, and a #fragment must be
   * a heading of the Markdown file it names.
   * @param {string} file the Markdown file the link is in (absolute)
   * @param {string} rel the same, repository-relative
   * @param {number} line
   * @param {string} target the link as written
   * @param {boolean} fromRoot resolve against the repository root, not the file's folder
   */
  const checkTarget = (file, rel, line, target, fromRoot) => {
    const hash = target.indexOf("#");
    const rawPath = hash < 0 ? target : target.slice(0, hash);
    const fragment = hash < 0 ? "" : target.slice(hash + 1);
    let path;
    try {
      path = decodeURIComponent(rawPath.split("?")[0]);
    } catch {
      failures.push(`${rel}:${line}  ${target}  (not a valid URL path)`);
      return;
    }
    const abs = path === "" ? file : fromRoot || path.startsWith("/") ? join(REPO, path) : resolve(dirname(file), path);
    const inRepo = toPosix(relative(REPO, abs));
    if (inRepo.startsWith("..")) {
      failures.push(`${rel}:${line}  ${target}  (outside the repository)`);
      return;
    }
    const target_ = posix.normalize(inRepo).replace(/\/$/, "");
    if (path !== "" && !published.has(target_) && !dirs.has(target_)) {
      failures.push(`${rel}:${line}  ${target}  (${existsSync(abs) ? "exists here, but git would not publish it" : "no such file or folder"})`);
      return;
    }
    if (fragment && /\.md$/i.test(abs)) {
      let anchor;
      try {
        anchor = decodeURIComponent(fragment).toLowerCase();
      } catch {
        anchor = fragment.toLowerCase();
      }
      if (!anchorsFor(abs).has(anchor)) failures.push(`${rel}:${line}  ${target}  (no heading "#${anchor}" in ${target_ || rel})`);
    }
  };

  for (const file of files) {
    const rel = toPosix(relative(REPO, file));
    const text = readFileSync(file, "utf8");
    for (const { line, target } of linksOf(text)) {
      if (isExternal(target)) {
        external++;
        continue;
      }
      checked++;
      checkTarget(file, rel, line, target, false);
    }
    for (const { line, target } of repoUrlsOf(text, base)) {
      urls++;
      checkTarget(file, rel, line, target, true);
    }
    if (rel.startsWith("docs/submission/")) {
      for (const answer of answersOf(text)) {
        answers++;
        if (answer.length > ANSWER_LIMIT) {
          failures.push(`${rel}:${answer.line}  a pasted answer of ${answer.length} characters (the portal takes ${ANSWER_LIMIT})`);
        }
      }
      for (const { line, value } of hexRefsOf(text)) {
        refs++;
        if (!inEvidence(value, known)) failures.push(`${rel}:${line}  ${value}  (not in the committed evidence)`);
      }
    }
    for (const { line, short, full } of shortLinkMismatches(text)) {
      failures.push(`${rel}:${line}  ${short}  (the link's text does not match its target ${full})`);
    }
  }

  console.log(
    `${files.length} files: ${checked} relative links and ${urls} links to ${base ?? "the repository on GitHub"} checked; ${external} external links not fetched; ${refs} hashes and addresses checked against ${known.size} in the evidence; ${answers} pasted answers within ${ANSWER_LIMIT} characters.`,
  );
  if (failures.length) {
    console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("Every link resolves and every hash is in the evidence.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
