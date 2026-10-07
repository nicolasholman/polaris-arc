import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The mark and logotype come from the workspace brand package.
  transpilePackages: ["@polaris/brand"],
  // Don't write AGENTS.md / CLAUDE.md into the app on `next dev`.
  agentRules: false,
  images: {
    // Assets in public/assets are dropped in by hand at any size, so they are
    // served as they are.
    unoptimized: true,
  },
  // The same baseline as the other apps: never sniffed, never framed, no
  // referrer path leaking to the sites it links to, no device APIs.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
