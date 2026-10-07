import "@fontsource-variable/hedvig-letters-serif";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "Halcyon · Objects for slower days", template: "%s · Halcyon" },
  description: "Headphones, lamps, chairs and everyday objects, made to be used for a decade. Free delivery over $150.",
  applicationName: "Halcyon",
};

export const viewport: Viewport = {
  themeColor: "#f7f4ee",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ground text-ink">{children}</body>
    </html>
  );
}
