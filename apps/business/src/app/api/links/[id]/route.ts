import { withMerchant } from "@/server/auth";
import { methodNotAllowed, ok, readJson } from "@/server/http";
import { deactivateLink } from "@/server/services";
import { parseUpdateLink } from "@/server/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Turn one of the caller's links off (`{ "active": false }`). Links are never deleted. */
export const PATCH = withMerchant<Ctx>(async (req, auth, { params }) => {
  const { id } = await params;
  parseUpdateLink(await readJson(req));
  return ok(await deactivateLink(auth, id));
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["PATCH"]);
export const GET = withMerchant(notAllowed);
export const POST = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
