import { notFound } from "next/navigation";
import { brandPng } from "@/lib/brand-assets";

/**
 * PWA icons for the manifest, from @polaris/brand. The Android app
 * (apps/android/twa-manifest.json) takes its launcher, splash and shortcut
 * icons from these URLs too.
 */
const ICONS = {
  "icon-192.png": "app-icon-192.png",
  "icon-512.png": "app-icon-512.png",
  "maskable-512.png": "app-icon-maskable-512.png",
  "shortcut-send.png": "shortcut-send.png",
  "shortcut-receive.png": "shortcut-receive.png",
} as const;

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(ICONS).map((name) => ({ name }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const file = ICONS[name as keyof typeof ICONS];
  if (!file) notFound();
  return brandPng(file);
}
