import { withMerchant } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { retryDelivery } from "@/server/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Retry one delivery now, from the delivery log. */
export const POST = withMerchant<Ctx>(async (_req, auth, { params }) => {
  const { id } = await params;
  return ok(await retryDelivery(auth, id));
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
