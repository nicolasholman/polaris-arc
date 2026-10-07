import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";
import { SmoothScroll } from "@/components/motion/SmoothScroll";
import { site } from "@/content";
import "./globals.css";

const interTight = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter-tight",
  display: "swap",
});

export const metadata: Metadata = {
  title: site.title,
  description: site.description,
  openGraph: {
    title: site.title,
    description: site.description,
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#2D3A02",
  width: "device-width",
  initialScale: 1,
};

/**
 * Without JavaScript nothing plays, so every reveal shows its final state:
 * the same rules as the reduced-motion block in globals.css, plus photos
 * (which otherwise wait for their load handler to fade in) and the values
 * that only a script would count up.
 */
const NO_SCRIPT_CSS = [
  ".reveal-word,.rv{opacity:1!important;filter:none!important;transform:none!important;clip-path:none!important}",
  ".rv-h{height:var(--rv-h)!important}",
  ".rv-w{width:auto!important}",
  ".rv-fill{background-color:var(--rv-bg)!important;color:var(--rv-fg)!important}",
  "img.opacity-0,video.opacity-0{opacity:1!important}",
  ".nojs-show{display:inline!important}",
  ".nojs-hide{display:none!important}",
].join("");

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={interTight.variable}>
      <head>
        <noscript>
          <style>{NO_SCRIPT_CSS}</style>
        </noscript>
      </head>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
      </body>
    </html>
  );
}
