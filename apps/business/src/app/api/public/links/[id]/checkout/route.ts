import { withPreflight, withPublic } from "@/server/auth";
import { HttpError, ok, methodNotAllowed } from "@/server/http";
import { openLink, publicSession } from "@/server/sessions/sessions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Open a payment link: a fresh checkout session with the link's terms (one
 * hour to pay, its own order id), returned in its public form.
 */
export const POST = withPublic<Ctx>(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!/^pl_[A-Za-z0-9]{8,64}$/.test(id)) throw new HttpError(404, "not_found", "This payment link doesn't exist.");
  const session = await openLink(id);
  return ok(await publicSession(session.id), 201);
});

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);
