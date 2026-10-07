import { brandPng } from "@/lib/brand-assets";

export const size = { width: 48, height: 48 };
export const contentType = "image/png";

/** The favicon: the Polaris mark. */
export default function Icon() {
  return brandPng("mark-48.png");
}
