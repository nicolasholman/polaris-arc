import { withMerchant } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { listPayments } from "@/server/services";

export const dynamic = "force-dynamic";

/** Every payment, newest first. "Succeeded" only ever comes from indexed chain events. */
export const GET = withMerchant(async (_req, auth) => ok(await listPayments(auth)));

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
