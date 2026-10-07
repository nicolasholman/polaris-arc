import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Gallery } from "@polaris/ui/gallery";

export const metadata: Metadata = {
  title: "Gallery",
  description: "Every @polaris/ui component in every variant, beside the reference it reproduces.",
};

/**
 * The component gallery: every shared component with sample values, for
 * design work. Development only: a production build has no sample data
 * anywhere, so the route is not found there.
 */
export default function GalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery app="business" />;
}
