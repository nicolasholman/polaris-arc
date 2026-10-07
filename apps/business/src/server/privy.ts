import "server-only";

import { PrivyClient } from "@privy-io/node";

/**
 * The server's Privy client, created on first use.
 *
 * `@privy-io/node` (not the deprecated `@privy-io/server-auth`). It is built
 * lazily so that `next build` and the setup screen work with no Privy
 * credentials at all; a route that needs it gets `null` and answers 503.
 *
 * `POLARIS_DISABLE_PRIVY=1` forces it off even when credentials are present:
 * the local end-to-end run sets it so nothing it does can reach the live
 * Privy app whose keys sit in `.env.local`.
 */

let client: PrivyClient | null | undefined;

export function privyServerConfig() {
  const appId = process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
  const appSecret = process.env.PRIVY_APP_SECRET || "";
  const disabled = process.env.POLARIS_DISABLE_PRIVY === "1";
  return { appId, appSecret, configured: Boolean(appId && appSecret) && !disabled };
}

export function getPrivy(): PrivyClient | null {
  if (client !== undefined) return client;
  const { appId, appSecret, configured } = privyServerConfig();
  client = configured
    ? new PrivyClient({
        appId,
        appSecret,
        jwtVerificationKey: process.env.PRIVY_VERIFICATION_KEY || undefined,
      })
    : null;
  return client;
}

/** Tests: forget the client so the next call reads the environment again. */
export function resetPrivyForTests(): void {
  client = undefined;
}
