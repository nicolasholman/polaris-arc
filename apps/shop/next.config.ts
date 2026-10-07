import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The store is never framed. It does open the Polaris checkout as a popup
  // and must keep a reference to it, so no Cross-Origin-Opener-Policy here.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No AGENTS.md / CLAUDE.md written into the app by `next dev`.
  agentRules: false,
  // The demo is recorded against `next dev`; keep Next's badge out of the shot
  // (it also sits where the "Built with Polaris" button does).
  devIndicators: false,
  // The workspace root, so a parent directory's lockfile is never mistaken for it.
  turbopack: { root: path.resolve(process.cwd(), "../..") },
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [390, 640, 828, 1080, 1440, 1920],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
