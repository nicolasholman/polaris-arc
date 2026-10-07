// Fails if any route handler under src/app/api is exported without the
// authentication its path requires.
//
// The old merchant platform trusted a wallet address sent in a header. The
// rule here is that every handler authenticates through src/server/auth.ts,
// with the wrapper its path calls for, and this check makes that a build-time
// fact rather than a convention:
//
//   src/app/api/v1/checkout/**   withSecretKey       (sk_ key: merchants' servers)
//   src/app/api/v1/relay/**      withPublishableKey  (pk_ key: merchants' pages)
//   src/app/api/relay/**         withSignedRequest   (the buyer's own signature)
//   src/app/api/public/**        withPublic          (public data only, rate-limited)
//   src/app/api/health/**        withPublic
//   src/app/api/cron/**          withCron            (CRON_SECRET)
//   src/app/api/credit/**        withSignedRequest   (the account's own consent signature)
//   src/app/api/receipts/**      withSignedRequest   (the account's own signature: its inbox key, a read)
//   src/app/api/cre/**           withCreCallback     (the CRE workflows' HMAC-signed callbacks)
//   everything else              withMerchant        (a verified Privy session)
//
// OPTIONS (CORS preflight) may be withPreflight(...) on the cross-origin paths.
//
// Every route also declares all of GET, POST, PUT, PATCH and DELETE, the ones
// it doesn't support through its wrapper and methodNotAllowed(...), so an
// unsupported method gets a JSON 405 rather than Next's empty one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/app/api", import.meta.url));
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const REQUIRED = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const RULES = [
  { prefix: "v1/checkout/", wrappers: ["withSecretKey"], preflight: false },
  { prefix: "v1/relay/", wrappers: ["withPublishableKey"], preflight: true },
  { prefix: "relay/", wrappers: ["withSignedRequest"], preflight: true },
  { prefix: "public/", wrappers: ["withPublic"], preflight: true },
  { prefix: "health/", wrappers: ["withPublic"], preflight: false },
  { prefix: "cron/", wrappers: ["withCron"], preflight: false },
  { prefix: "credit/", wrappers: ["withSignedRequest"], preflight: true },
  { prefix: "receipts/", wrappers: ["withSignedRequest"], preflight: true },
  { prefix: "cre/", wrappers: ["withCreCallback"], preflight: false },
  { prefix: "", wrappers: ["withMerchant"], preflight: false },
];

function* routes(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* routes(path);
    else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) yield path;
  }
}

const problems = [];
const counts = {};
let checked = 0;

for (const file of routes(root)) {
  const source = readFileSync(file, "utf8");
  const rel = relative(process.cwd(), file);
  const apiPath = relative(root, file).split(sep).join("/");
  const rule = RULES.find((r) => apiPath.startsWith(r.prefix));
  checked++;

  if (!/from\s+["']@\/server\/auth["']/.test(source)) {
    problems.push(`${rel}: does not import from @/server/auth`);
  }
  if (/x-wallet-address/i.test(source)) {
    problems.push(`${rel}: reads a wallet address from a header`);
  }
  for (const method of METHODS) {
    const declared = new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${method}\\b`).test(source);
    if (!declared) {
      if (REQUIRED.includes(method)) problems.push(`${rel}: declare ${method} (methodNotAllowed through its wrapper), so it answers a JSON 405`);
      continue;
    }
    const allowed = method === "OPTIONS" && rule.preflight ? [...rule.wrappers, "withPreflight"] : rule.wrappers;
    const wrapped = allowed.some((w) => new RegExp(`export\\s+const\\s+${method}\\s*=\\s*${w}\\s*(<[^>]*>)?\\s*\\(`).test(source));
    if (!wrapped) {
      problems.push(`${rel}: ${method} must be exported as ${allowed.join(" or ")}(...) on /api/${rule.prefix || "*"}`);
    } else {
      const used = allowed.find((w) => new RegExp(`export\\s+const\\s+${method}\\s*=\\s*${w}\\b`).test(source));
      counts[used] = (counts[used] ?? 0) + 1;
    }
  }
  if (/export\s*\{[^}]*\b(GET|POST|PUT|PATCH|DELETE|OPTIONS)\b[^}]*\}/.test(source)) {
    problems.push(`${rel}: re-exports a handler; declare it with its wrapper in place`);
  }
}

if (problems.length) {
  console.error(`API auth check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const summary = Object.entries(counts)
  .map(([w, n]) => `${n} ${w}`)
  .join(", ");
console.log(`API auth check: ${checked} route files, every handler authenticated (${summary}).`);
