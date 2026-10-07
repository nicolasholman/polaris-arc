import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** packages/brand/assets, from the app (the usual cwd) or the repository root. */
function assetsDir(): string {
  const candidates = [
    path.join(process.cwd(), "..", "..", "packages", "brand", "assets"),
    path.join(process.cwd(), "packages", "brand", "assets"),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
}

/**
 * The team's rendered icons, straight from @polaris/brand, served as PNGs.
 * The routes that use it are static, so this runs at build time only; the
 * ignore comment keeps the server bundle from tracing the whole repository.
 */
export async function brandPng(name: string): Promise<Response> {
  const bytes = await readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ assetsDir(), name));
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
