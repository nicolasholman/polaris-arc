/**
 * The Polaris gateway: serves the underwriting API.
 *
 *   pnpm --filter @polarispay/gateway start        # http://127.0.0.1:3510
 *
 * Reads its configuration from the environment (and `apps/gateway/.env` when
 * present; see .env.example). Each provider is live with its key
 * (NANSEN_API_KEY, ZERION_API_KEY, ETHERSCAN_API_KEY) or not configured
 * without it, and says so on every start, in `/health` (`modes`,
 * `notConfigured`) and in every underwriting (`providers`, `notConfigured`,
 * `absent`). A provider that is not configured is never called and nothing
 * answers in its place; public RPCs need no key and are always live.
 *
 * Without UNDERWRITING_API_TOKEN it serves loopback only: a HOST that is not
 * loopback (0.0.0.0, a LAN address, a public name) makes it refuse to start.
 */

import { pathToFileURL } from "node:url";
import { startUnderwritingServer, Underwriter } from "@polarispay/underwriting";

export async function startGateway(env: Record<string, string | undefined> = process.env) {
  const underwriter = Underwriter.fromEnv(env);
  const { server, url } = await startUnderwritingServer({
    underwriter,
    port: Number(env.PORT || 3510),
    // An empty HOST= in .env would bind every interface; it means the default.
    host: env.HOST || "127.0.0.1",
    token: env.UNDERWRITING_API_TOKEN || undefined,
    corsOrigins: (env.UNDERWRITING_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  return { server, url, underwriter };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url, underwriter } = await startGateway();
  const modes = underwriter.modes();
  console.log(`polaris gateway listening on ${url}`);
  console.log(`  providers: ${Object.entries(modes).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  for (const { provider, env } of underwriter.notConfigured()) {
    console.log(`  ${provider} is not configured (set ${env}): it is never called, and what only it reads counts for nothing.`);
  }
  if (!process.env.UNDERWRITING_API_TOKEN?.trim()) {
    console.log("  no UNDERWRITING_API_TOKEN: /v1/* needs no token, so it listens on loopback only.");
  }
}
