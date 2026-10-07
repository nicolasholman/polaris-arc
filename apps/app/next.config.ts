import path from "node:path";
import type { NextConfig } from "next";

const development = process.env.NODE_ENV === "development";

/**
 * Headers every page gets.
 *
 * - Checkout and claim run Face ID ceremonies, so the app refuses to be framed
 *   (WebKit also refuses passkey creation in cross-origin frames).
 * - `no-referrer`: claim links carry a key in the URL fragment. Browsers never
 *   put the fragment in a Referer, but nothing on these pages needs to leak
 *   the path either.
 * - Camera is for the QR scanner on /pay; passkeys only for this origin.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value:
      'camera=(self), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No floating dev badge over the phone layout.
  devIndicators: false,
  // No AGENTS.md / CLAUDE.md written into the app by `next dev`.
  agentRules: false,
  env: {
    // The dev signer (a key in browser storage standing in for Face ID) exists in `next dev` alone.
    // A production build blanks it, whatever .env.local says, so a hosted build can only use Face ID
    // (Mera) or email (Privy). POLARIS_ALLOW_DEV_SIGNER_BUILD=1 builds it in knowingly (a local CI run).
    NEXT_PUBLIC_DEV_SIGNER: development || process.env.POLARIS_ALLOW_DEV_SIGNER_BUILD === "1" ? (process.env.NEXT_PUBLIC_DEV_SIGNER ?? "") : "",
    NEXT_PUBLIC_DEV_SIGNER_PERSIST: development ? (process.env.NEXT_PUBLIC_DEV_SIGNER_PERSIST ?? "") : "",
  },
  // The shared component library, the Chainlink rates package and the receipts keys ship TypeScript source.
  transpilePackages: ["@polaris/ui", "@polaris/brand", "@polaris/fx", "@polaris/receipts"],
  // The workspace root, so a parent directory's lockfile is never mistaken for it.
  turbopack: { root: path.resolve(process.cwd(), "../..") },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
