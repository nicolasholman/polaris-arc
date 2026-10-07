import { withPreflight, withSignedRequest } from "@/server/auth";
import { ok, readJson, methodNotAllowed } from "@/server/http";
import { handleRelay } from "@/server/relayer/relay";

export const dynamic = "force-dynamic";

/**
 * The relayer, for the Polaris app: Pay now, Pay in 4, Subscribe, send and
 * claim by link, pay early, cancel. The buyer's own EIP-712 signature is the
 * credential; it is verified here, checked against the checkout session,
 * simulated, and carried by the Privy server wallet whose policy allows only
 * these calls. See src/server/relayer/relay.ts for the request shapes.
 */
export const POST = withSignedRequest(async (req) => ok(await handleRelay(await readJson(req))));

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withSignedRequest(notAllowed);
export const PUT = withSignedRequest(notAllowed);
export const PATCH = withSignedRequest(notAllowed);
export const DELETE = withSignedRequest(notAllowed);
