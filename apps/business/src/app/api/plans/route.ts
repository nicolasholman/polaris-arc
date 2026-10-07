import { withMerchant } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { listPlans } from "@/server/services";

export const dynamic = "force-dynamic";

/** The Pay in 4 ledger: every plan this merchant originated, from PlanOpened and the instalment events. */
export const GET = withMerchant(async (_req, auth) => ok(await listPlans(auth)));

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
