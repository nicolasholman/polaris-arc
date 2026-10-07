import "./globals.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/shell/providers";

const description = "Pay in full, in four or every month, and send dollars anywhere with a link. Just Face ID.";

export const metadata: Metadata = {
  metadataBase: new URL("https://app.polarispay.app"),
  title: { default: "Polaris", template: "%s · Polaris" },
  description,
  applicationName: "Polaris",
  appleWebApp: { capable: true, title: "Polaris", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, email: false, address: false },
  other: {
    // Older iOS reads only the prefixed name.
    "apple-mobile-web-app-capable": "yes",
    "mobile-web-app-capable": "yes",
  },
  openGraph: { title: "Polaris", description, siteName: "Polaris", type: "website" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Dark, like refs A and B.
  colorScheme: "dark",
  themeColor: "#0f1011",
};

/**
 * `sheet` is the parallel route every sheet renders into (app/@sheet): an
 * intercepting route when opened from inside the app, so it slides up over
 * the current tab and its URL still deep-links.
 *
 * Below 1024px the app is dark (refs A to D); from 1024px it is ref E's dark
 * panel on the lime canvas (`data-theme-lg`, see packages/ui/styles.css).
 */
export default function RootLayout({ children, sheet }: { children: ReactNode; sheet: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-theme-lg="ref-e">
      <body className="ui-root">
        <a
          href="#main"
          className="sr-only-focusable fixed top-3 left-3 z-[1100] rounded-full bg-ui-lime px-4 py-2 text-[14px] font-medium text-ui-on-lime"
        >
          Skip to content
        </a>
        <Providers sheet={sheet}>{children}</Providers>
      </body>
    </html>
  );
}
