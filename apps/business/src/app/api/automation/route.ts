import { withMerchant } from "@/server/auth";
import { keeperOverview } from "@/server/keeper/overview";
import { methodNotAllowed, ok } from "@/server/http";
import { ensureMerchant } from "@/server/merchants";

export const dynamic = "force-dynamic";

/**
 * The Chainlink page: the three keeper (their triggers, their latest
 * reports on Arc with each transaction, what each did), the credit guard's
 * verdict and thresholds, and the guardian read as a feed. From the chain
 * sync's records of the receivers' events and the guardian's views now.
 */
export const GET = withMerchant(async (_req, auth) => ok(await keeperOverview(await ensureMerchant(auth))));

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
