import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

import { Icons } from "@/components/app/icons";

/**
 * Satoshi through next/font: the page preloads it and falls back to a
 * metric-matched Arial, so the hero and the figures don't reflow when it
 * arrives. globals.css points the library's --font-satoshi at it; the
 * library's own @font-face stays for the other apps. next/font names the
 * family after this constant, so it must not be "satoshi": CSS family names
 * ignore case, and it would merge with the library's "Satoshi" face and
 * download the file twice.
 */
const polarisSatoshi = localFont({
  src: "../../../../packages/ui/fonts/Satoshi-Variable.woff2",
  weight: "300 900",
  style: "normal",
  display: "swap",
  variable: "--font-satoshi-next",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: {
    default: "Polaris for Business",
    template: "%s · Polaris for Business",
  },
  description:
    "Payment links with credit built in. Take payments in full, in four instalments or on a subscription, and get paid in dollars in under a second.",
  applicationName: "Polaris for Business",
};

export const viewport: Viewport = {
  themeColor: "#121418",
  colorScheme: "dark",
};

/**
 * The root: ref E's theme (a dark panel on a lime canvas, docs/design/system.md),
 * Satoshi, the library's tokens. No sign-in here: Privy mounts
 * in the (privy) group (landing, /login, /dashboard), so the 404 page and the
 * gallery render without it.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="ref-e" className={polarisSatoshi.variable}>
      <body className="ui-root">
        <Icons>{children}</Icons>
      </body>
    </html>
  );
}
