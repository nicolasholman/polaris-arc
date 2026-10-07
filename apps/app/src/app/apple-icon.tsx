import { brandPng } from "@/lib/brand-assets";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** The home-screen icon on iOS: the lime star on ink. */
export default function AppleIcon() {
  return brandPng("apple-touch-icon.png");
}
