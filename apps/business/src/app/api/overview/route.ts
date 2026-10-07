import { withMerchant } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { getOverview } from "@/server/services";

export const dynamic = "force-dynamic";

/** Home: balance, today's payments, Pay in 4 exposure, collector and payout status. */
export const GET = withMerchant(async (_req, auth) => ok(await getOverview(auth)));

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
