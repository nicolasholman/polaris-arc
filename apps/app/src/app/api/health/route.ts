import { buildInfo } from "@/lib/build-info";
import { env } from "@/lib/env";

/**
 * GET /api/health: the app is up, and what this build was compiled with
 * (src/lib/build-info.ts): public values only, for scripts/deploy-check.mjs.
 * Each `process.env.NEXT_PUBLIC_*` is written out so Next inlines the value
 * the bundle has, not whatever the server's environment says now. Those are
 * fixed when the app is built, so the answer is rendered once, at build time.
 */

export const dynamic = "force-static";

export function GET(): Response {
  const info = buildInfo({
    env,
    nodeEnv: process.env.NODE_ENV,
    devSignerPersist: process.env.NEXT_PUBLIC_DEV_SIGNER_PERSIST,
    localDemo: process.env.NEXT_PUBLIC_LOCAL_DEMO,
    localFaucetUrl: process.env.NEXT_PUBLIC_LOCAL_FAUCET_URL,
    buildTarget: process.env.NEXT_PUBLIC_BUILD_TARGET,
  });
  return Response.json({ ok: true, ...info });
}
