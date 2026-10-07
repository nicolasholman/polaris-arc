import { withPreflight, withPublishableKey } from "@/server/auth";
import { ok, readJson, methodNotAllowed } from "@/server/http";
import { handleSdkRelay } from "@/server/relayer/relay";

export const dynamic = "force-dynamic";

/**
 * polarispay-sdk `pay()` with `relayUrl`: the buyer's ERC-3009
 * authorisation, carried to `PolarisPayments.payWithAuthorization` by the
 * policy-locked relayer, so the buyer needs dollars and nothing else.
 * Publishable key; callable from any origin (no cookies are involved).
 */
export const POST = withPublishableKey(async (req, { merchant }) => ok(await handleSdkRelay(merchant, await readJson(req)), 201));

export const OPTIONS = withPreflight("any");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withPublishableKey(notAllowed);
export const PUT = withPublishableKey(notAllowed);
export const PATCH = withPublishableKey(notAllowed);
export const DELETE = withPublishableKey(notAllowed);
