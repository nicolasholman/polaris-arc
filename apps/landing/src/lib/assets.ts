import fs from "node:fs";
import path from "node:path";

/**
 * The image slots on the page. Files are dropped into public/assets by hand;
 * until one exists its slot shows a gradient in the section's palette.
 */
export const ASSET_FILES = [
  "hero.jpg",
  "streaks.jpg",
  "streaks.mp4",
  "phone.jpg",
  "testimonial.jpg",
  "article-1.jpg",
  "article-2.jpg",
  "article-3.jpg",
  "avatar-1.jpg",
  "avatar-2.jpg",
  "avatar-3.jpg",
] as const;

export type AssetFile = (typeof ASSET_FILES)[number];

/** File name to public URL, for the files that are present. */
export type Assets = Partial<Record<AssetFile, string>>;

/**
 * Checks which assets exist on disk, so the page never requests a missing
 * file (no 404s in the console). Runs at build time for the static page and
 * per request in `next dev`, so a dropped-in file shows up on reload.
 */
export function getAssets(): Assets {
  const dir = path.join(process.cwd(), "public", "assets");
  const found: Assets = {};
  for (const file of ASSET_FILES) {
    try {
      const stat = fs.statSync(path.join(dir, file));
      if (stat.isFile() && stat.size > 0) {
        // The size busts the browser cache when a file is replaced.
        found[file] = `/assets/${file}?v=${stat.size}`;
      }
    } catch {
      // Missing: the slot falls back to its gradient.
    }
  }
  return found;
}
