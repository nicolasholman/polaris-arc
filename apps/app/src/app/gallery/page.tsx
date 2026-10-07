import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Gallery } from "@polaris/ui/gallery";

export const metadata: Metadata = {
  title: "Gallery",
  description: "Every @polaris/ui component in every variant, beside the reference it reproduces.",
};

/**
 * The component gallery: every shared component, no account needed.
 * Development only: its cards carry made-up values, so a production build
 * answers 404.
 */
export default function GalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery app="app" />;
}
