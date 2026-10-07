import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";
import allowed from "../scripts/api-routes.json";

/**
 * The store's API is exactly scripts/api-routes.json, which
 * scripts/assert-api-routes.mjs also holds `next build` to: nothing under
 * src/app/api answers for Polaris or exists only for testing.
 */

const APP = fileURLToPath(new URL("../src/app", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.relative(APP, path.join(dir, entry.name))],
  );
}

describe("the store's routes", () => {
  it("serves only the API in scripts/api-routes.json", () => {
    const routes = files(path.join(APP, "api"))
      .filter((file) => /(^|\/)route\.[jt]sx?$/.test(file))
      .map((file) => `/${path.dirname(file).split(path.sep).join("/")}`)
      .sort();
    expect(routes).toEqual([...allowed.routes].sort());
  });

  it("has no build-dependent routes", () => {
    expect(nextConfig.pageExtensions).toBeUndefined();
    expect(files(APP).filter((file) => /\.dev\.[jt]sx?$/.test(file))).toEqual([]);
  });
});
