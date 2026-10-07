import { withMerchant } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { revokeApiKey } from "@/server/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Revoke a key pair. Requests with its secret or publishable key fail from now on. */
export const DELETE = withMerchant<Ctx>(async (_req, auth, { params }) => {
  const { id } = await params;
  return ok(await revokeApiKey(auth, id));
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["DELETE"]);
export const GET = withMerchant(notAllowed);
export const POST = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
