import { withCreCallback } from "@/server/auth";
import { handleCreCallback } from "@/server/credit/callback";
import { methodNotAllowed, ok } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * The CRE workflows' signed reports after a run (underwriting decisions, and
 * collections runs), verified against POLARIS_CRE_CALLBACK_SECRET. See
 * src/server/credit/callback.ts.
 */
export const POST = withCreCallback(async (_req, body) => ok(await handleCreCallback(body)));

/* Everything else answers a JSON 405 naming what the route accepts (after the signature check). */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withCreCallback(notAllowed);
export const PUT = withCreCallback(notAllowed);
export const PATCH = withCreCallback(notAllowed);
export const DELETE = withCreCallback(notAllowed);
