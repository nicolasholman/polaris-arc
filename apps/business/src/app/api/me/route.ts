import { withMerchant } from "@/server/auth";
import { ok, readJson, methodNotAllowed } from "@/server/http";
import { merchantFor, updateMerchant } from "@/server/services";
import { parseBusinessName } from "@/server/validate";

export const dynamic = "force-dynamic";

/** The signed-in merchant: business name, payout wallet, email, registration state. */
export const GET = withMerchant(async (_req, auth) => ok(await merchantFor(auth)));

/**
 * Onboarding and settings: set the business name. Registering it on chain is
 * the next step, `/api/merchant/registration`, signed by the payout wallet.
 */
export const POST = withMerchant(async (req, auth) => {
  const input = parseBusinessName(await readJson(req));
  return ok(await updateMerchant(auth, input));
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET", "POST"]);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
