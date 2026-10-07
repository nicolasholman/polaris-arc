import { withMerchant } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { deleteWebhook } from "@/server/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Remove an endpoint. Queued deliveries to it are dropped. */
export const DELETE = withMerchant<Ctx>(async (_req, auth, { params }) => {
  const { id } = await params;
  return ok(await deleteWebhook(auth, id));
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["DELETE"]);
export const GET = withMerchant(notAllowed);
export const POST = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
