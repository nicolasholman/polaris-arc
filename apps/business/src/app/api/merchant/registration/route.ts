import { withMerchant } from "@/server/auth";
import { ok, readJson, methodNotAllowed } from "@/server/http";
import { getRegistration, submitRegistration } from "@/server/onboarding";

export const dynamic = "force-dynamic";

/**
 * MerchantRegistry onboarding. GET returns the registration state and, when
 * one is needed, the EIP-712 `Registration` for the payout wallet to sign;
 * POST takes the signature and relays `registerFor` (the merchant holds no
 * MON), then activates the merchant for Pay in 4 when a registry admin is
 * configured.
 */
export const GET = withMerchant(async (_req, auth) => ok(await getRegistration(auth)));

export const POST = withMerchant(async (req, auth) => ok(await submitRegistration(auth, await readJson(req))));

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET", "POST"]);
export const PUT = withMerchant(notAllowed);
export const PATCH = withMerchant(notAllowed);
export const DELETE = withMerchant(notAllowed);
