import { withSecretKey } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { assertSessionId } from "@/server/sessions/params";
import { retrieveSession, toApiSession } from "@/server/sessions/sessions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** `polaris.checkout.sessions.retrieve(id)`: the session, with `payment` once the chain says it's paid. */
export const GET = withSecretKey<Ctx>(async (_req, { merchant }, { params }) => {
  const { id } = await params;
  return ok(toApiSession(await retrieveSession(merchant, assertSessionId(id))));
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withSecretKey(notAllowed);
export const PUT = withSecretKey(notAllowed);
export const PATCH = withSecretKey(notAllowed);
export const DELETE = withSecretKey(notAllowed);
