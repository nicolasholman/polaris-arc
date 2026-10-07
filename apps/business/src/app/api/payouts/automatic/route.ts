import { withMerchant } from "@/server/auth";
import { ok, readJson, methodNotAllowed } from "@/server/http";
import { setAutoPayouts } from "@/server/services";
import { parseAutoPayouts } from "@/server/validate";

export const dynamic = "force-dynamic";

/**
 * Turn automatic daily payouts on or off. Turning them on creates the Privy
 * policy that pins our payout signer to this payout address; the browser then
 * adds the signer to the merchant's wallet with that policy.
 */
export const POST = withMerchant(async (req, auth) => {
  const input = parseAutoPayouts(await readJson(req));
  return ok(await setAutoPayouts(auth, input));
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["POST"]);
export const GET = withMerchant(notAllowed);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
