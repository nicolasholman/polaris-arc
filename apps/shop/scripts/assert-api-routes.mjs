// Fails the production build if it serves any API route but the store's own.
//
// Halcyon's server API is small and fixed (scripts/api-routes.json): placing
// an order, reading it back, the health report and the Polaris webhook. It
// pays only through Polaris for Business; a route beyond that list (a stand-in
// for Polaris, a test hook) would be something the store must not ship, so
// after `next build` this compares the routes Next compiled with the list.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, ".next");
const { routes: expected } = JSON.parse(readFileSync(path.join(root, "scripts", "api-routes.json"), "utf8"));

const manifest = path.join(dist, "app-path-routes-manifest.json");
if (!existsSync(manifest)) {
  console.error(`No ${path.relative(root, manifest)}: run next build first.`);
  process.exit(1);
}

// { "/api/checkout/route": "/api/checkout", "/(store)/page": "/", ... }
const built = [...new Set(Object.values(JSON.parse(readFileSync(manifest, "utf8"))))].filter((route) => route === "/api" || route.startsWith("/api/"));

const extra = built.filter((route) => !expected.includes(route));
const missing = expected.filter((route) => !built.includes(route));
const problems = [...extra.map((route) => `${route} is in the build but not in scripts/api-routes.json`), ...missing.map((route) => `${route} is missing from the build`)];

if (problems.length > 0) {
  console.error("The build's API routes aren't the store's:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`OK: the build serves exactly the store's ${built.length} API routes (${built.join(", ")}).`);
