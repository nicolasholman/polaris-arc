#!/usr/bin/env node
// Build the workspace packages this app imports compiled (@polarispay/underwriting's
// dist) when they are missing or older than their source, so `pnpm dev`, `build`,
// `typecheck` and `test` work straight after a fresh install. Quick when nothing changed.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function newest(dir) {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    latest = Math.max(latest, stat.isDirectory() ? newest(path) : stat.mtimeMs);
  }
  return latest;
}

const packages = [{ name: "@polarispay/underwriting", dir: join(REPO, "packages", "underwriting"), output: join("dist", "core", "index.js") }];

for (const pkg of packages) {
  const output = join(pkg.dir, pkg.output);
  if (existsSync(output) && statSync(output).mtimeMs >= newest(join(pkg.dir, "src"))) continue;
  console.log(`Building ${pkg.name}…`);
  const r = spawnSync("pnpm", ["--filter", pkg.name, "build"], { cwd: REPO, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
