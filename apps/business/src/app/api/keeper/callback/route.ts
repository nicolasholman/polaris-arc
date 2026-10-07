import { withKeeperCallback } from "@/server/auth";
import { handleKeeperCallback } from "@/server/credit/callback";
import { methodNotAllowed, ok } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * The keeper' signed reports after a run (underwriting decisions, and
 * collections runs), verified against POLARIS_KEEPER_CALLBACK_SECRET. See
 * src/server/credit/callback.ts.
 */
export const POST = withKeeperCallback(async (_req, body) => ok(await handleKeeperCallback(body)));

/* Everything else answers a JSON 405 naming what the route accepts (after the signature check). */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withKeeperCallback(notAllowed);
export const PUT = withKeeperCallback(notAllowed);
export const PATCH = withKeeperCallback(notAllowed);
export const DELETE = withKeeperCallback(notAllowed);
