import { withMerchant } from "@/server/auth";
import { ok, methodNotAllowed } from "@/server/http";
import { payoutNow } from "@/server/services";

export const dynamic = "force-dynamic";

/**
 * "Pay out now": run the caller's automatic payout immediately, signed by the
 * Privy payout signer under the merchant's own payout policy.
 */
export const POST = withMerchant(async (_req, auth) => ok(await payoutNow(auth)));

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
