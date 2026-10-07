import path from "node:path";
import type { NextConfig } from "next";

const development = process.env.NODE_ENV === "development";

/** The workspace root, so a parent directory's lockfile is never mistaken for it. */
const root = path.resolve(process.cwd(), "../..");

/**
 * POLARIS_NEXT_OUTPUT=standalone (the Dockerfile sets it) writes Next's
 * standalone server: `.next/standalone/apps/business/server.js` and only the
 * files it traces from the workspace, which is what the production image
 * copies. Unset, `next build && next start` work as usual.
 */
const standalone = process.env.POLARIS_NEXT_OUTPUT === "standalone";

/** The dashboard moved under /dashboard; old deep links keep working. */
const MOVED = ["payments", "links", "plans", "payouts", "developers"];

const config: NextConfig = {
  reactStrictMode: true,
  // No floating dev badge over the sidebar (it only exists in `next dev`).
  devIndicators: false,
  poweredByHeader: false,
  // The component library, the brand and @polaris/db ship TypeScript source.
  transpilePackages: ["@polaris/ui", "@polaris/brand", "@polaris/db", "@polaris/receipts", "@polarispay/indexer-client"],
  // The Privy Node SDK verifies tokens with `jose` and signs wallet requests with
  // node:crypto. Keep it out of the server bundle so it loads as plain Node.
  serverExternalPackages: ["@privy-io/node"],
  ...(standalone ? { output: "standalone" as const } : {}),
  outputFileTracingRoot: root,
  turbopack: { root },
  env: {
    // `pnpm demo:local`'s signed-in dashboard on a local chain; never in a production build.
    NEXT_PUBLIC_POLARIS_LOCAL_SESSION: development ? (process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION ?? "") : "",
    NEXT_PUBLIC_POLARIS_LOCAL_SESSION_WALLET: development ? (process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION_WALLET ?? "") : "",
    NEXT_PUBLIC_POLARIS_LOCAL_SESSION_KEY: development ? (process.env.NEXT_PUBLIC_POLARIS_LOCAL_SESSION_KEY ?? "") : "",
  },
  images: {
    formats: ["image/avif", "image/webp"],
  },
  async redirects() {
    return MOVED.flatMap((path) => [
      { source: `/${path}`, destination: `/dashboard/${path}`, permanent: false },
      { source: `/${path}/:rest*`, destination: `/dashboard/${path}/:rest*`, permanent: false },
    ]);
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Browsers honour it over HTTPS only. Fly and Railway don't add it for us (Vercel does, for the other apps).
          ...(development ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000" }]),
        ],
      },
      {
        // Nothing an API route returns is safe to cache: it is all per merchant.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default config;
